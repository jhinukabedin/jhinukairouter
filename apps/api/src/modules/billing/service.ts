// Billing: Platform Credit wallet + BYOK tracking + budgets.
// Rules (CONTRACT.md):
// - BYOK: track usage only, NEVER charge platform credits.
// - Platform Credit: atomic debit via DB transaction, immutable
//   CreditTransaction ledger, idempotencyKey unique, refunds, pre-request
//   balance check, insufficient-balance error, admin credit adjust.
// - Budgets: daily/monthly/per-model/per-provider/per-key limits, enforced
//   pre-request.
// Money is handled in integer minor units where possible; this service
// works in Decimal-like numbers (major units) and rounds to 2dp on write.
// The store interface is what must be transactional in production (Prisma
// $transaction); the in-memory store simulates it with a mutex so tests
// can verify idempotency + no double-charge at service level.
export type CreditType = 'PURCHASE' | 'DEBIT' | 'REFUND' | 'ADJUSTMENT';
export type BillingMode = 'BYOK' | 'PLATFORM_CREDIT';

export interface CreditWallet {
  userId: string;
  balance: number;
  currency: string;
}

export interface CreditTransaction {
  id: string;
  walletId: string; // userId of the wallet owner
  amount: number; // signed: negative = debit
  type: CreditType;
  idempotencyKey: string;
  requestId?: string | null;
  description?: string | null;
  createdAt: string;
}

export interface BudgetLimit {
  id: string;
  userId: string;
  scope: 'DAILY' | 'MONTHLY' | 'PER_MODEL' | 'PER_PROVIDER' | 'PER_KEY';
  /** Model / provider / apiKey id for scoped budgets; null for DAILY/MONTHLY. */
  scopeKey?: string | null;
  limitCredits: number;
  createdAt: string;
}

export interface BudgetUsage {
  userId: string;
  scope: BudgetLimit['scope'];
  scopeKey?: string | null;
  /** Window start, e.g. "2026-11-20" (daily) or "2026-11" (monthly). */
  window: string;
  usedCredits: number;
}

export interface BillingStore {
  getWallet(userId: string): Promise<CreditWallet | null>;
  createWallet(userId: string, currency?: string): Promise<CreditWallet>;
  /** Run fn atomically (Prisma $transaction in prod). Must serialise per wallet. */
  transact<T>(fn: () => Promise<T>): Promise<T>;
  /** Inside transact: apply a signed amount and append the ledger row. */
  applyTransaction(tx: Omit<CreditTransaction, 'id' | 'createdAt'>): Promise<CreditTransaction>;
  findTransactionByIdempotencyKey(key: string): Promise<CreditTransaction | null>;
  listTransactions(userId: string, limit?: number, offset?: number): Promise<{ rows: CreditTransaction[]; total: number }>;
  upsertBudget(b: BudgetLimit): Promise<BudgetLimit>;
  listBudgets(userId: string): Promise<BudgetLimit[]>;
  deleteBudget(id: string, userId: string): Promise<boolean>;
  getBudgetUsage(userId: string, scope: BudgetLimit['scope'], scopeKey: string | null, window: string): Promise<BudgetUsage | null>;
  addBudgetUsage(usage: BudgetUsage): Promise<void>;
}

export class InsufficientBalanceError extends Error {
  constructor(public readonly balance: number, public readonly needed: number) {
    super(`insufficient platform credit: balance ${balance}, need ${needed}`);
    this.name = 'InsufficientBalanceError';
  }
}

export class BudgetExceededError extends Error {
  constructor(public readonly budget: BudgetLimit, public readonly used: number, public readonly needed: number) {
    super(`budget exceeded: ${budget.scope}${budget.scopeKey ? `/${budget.scopeKey}` : ''} used ${used}, limit ${budget.limitCredits}`);
    this.name = 'BudgetExceededError';
  }
}

export class DuplicateIdempotencyError extends Error {
  constructor() { super('duplicate idempotency key with a different payload'); this.name = 'DuplicateIdempotencyError'; }
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const todayWindow = (d = new Date()) => d.toISOString().slice(0, 10);
const monthWindow = (d = new Date()) => d.toISOString().slice(0, 7);

export class BillingService {
  constructor(private store: BillingStore) {}

  async getWallet(userId: string): Promise<CreditWallet> {
    const existing = await this.store.getWallet(userId);
    if (existing) return existing;
    return this.store.createWallet(userId);
  }

  async listTransactions(userId: string, limit = 50, offset = 0) {
    return this.store.listTransactions(userId, limit, offset);
  }

  /** Admin-only credit adjust (positive = add, negative = remove). */
  async adjust(userId: string, amount: number, idempotencyKey: string, description?: string): Promise<CreditTransaction> {
    const existing = await this.store.findTransactionByIdempotencyKey(idempotencyKey);
    if (existing) return existing;
    return this.store.transact(async () => {
      const again = await this.store.findTransactionByIdempotencyKey(idempotencyKey);
      if (again) return again;
      await this.getWallet(userId);
      return this.store.applyTransaction({
        walletId: userId, amount: round2(amount), type: 'ADJUSTMENT',
        idempotencyKey, description: description ?? 'admin adjustment',
      });
    });
  }

  /** Purchase (top-up). */
  async purchase(userId: string, amount: number, idempotencyKey: string): Promise<CreditTransaction> {
    if (amount <= 0) throw new Error('purchase amount must be positive');
    const existing = await this.store.findTransactionByIdempotencyKey(idempotencyKey);
    if (existing) return existing;
    return this.store.transact(async () => {
      const again = await this.store.findTransactionByIdempotencyKey(idempotencyKey);
      if (again) return again;
      await this.getWallet(userId);
      return this.store.applyTransaction({ walletId: userId, amount: round2(amount), type: 'PURCHASE', idempotencyKey, description: 'credit purchase' });
    });
  }

  /**
   * Pre-request charge for Platform Credit mode.
   * BYOK callers must not call this (or pass mode BYOK — it no-ops and
   * returns null, tracking only). Idempotent: the same idempotencyKey
   * returns the original transaction and never double-charges.
   */
  async debit(
    userId: string,
    amount: number,
    idempotencyKey: string,
    opts: { requestId?: string; mode?: BillingMode; description?: string } = {},
  ): Promise<CreditTransaction | null> {
    if (opts.mode === 'BYOK') return null; // track only, never charge
    if (amount <= 0) throw new Error('debit amount must be positive');
    const existing = await this.store.findTransactionByIdempotencyKey(idempotencyKey);
    if (existing) {
      if (existing.type !== 'DEBIT' || existing.amount !== -round2(amount)) throw new DuplicateIdempotencyError();
      return existing;
    }
    return this.store.transact(async () => {
      const again = await this.store.findTransactionByIdempotencyKey(idempotencyKey);
      if (again) return again;
      const wallet = await this.getWallet(userId);
      if (wallet.balance < round2(amount)) {
        throw new InsufficientBalanceError(wallet.balance, round2(amount));
      }
      return this.store.applyTransaction({
        walletId: userId, amount: -round2(amount), type: 'DEBIT',
        idempotencyKey, requestId: opts.requestId ?? null,
        description: opts.description ?? 'platform credit charge',
      });
    });
  }

  /** Refund a previous debit (by its idempotencyKey). */
  async refund(userId: string, originalIdempotencyKey: string, idempotencyKey: string, amount?: number): Promise<CreditTransaction> {
    const original = await this.store.findTransactionByIdempotencyKey(originalIdempotencyKey);
    if (!original || original.type !== 'DEBIT') throw new Error('original debit not found');
    const refundAmount = round2(amount ?? -original.amount);
    if (refundAmount <= 0 || refundAmount > -original.amount) throw new Error('invalid refund amount');
    const existing = await this.store.findTransactionByIdempotencyKey(idempotencyKey);
    if (existing) return existing;
    return this.store.transact(async () => {
      const again = await this.store.findTransactionByIdempotencyKey(idempotencyKey);
      if (again) return again;
      await this.getWallet(userId);
      return this.store.applyTransaction({
        walletId: userId, amount: refundAmount, type: 'REFUND',
        idempotencyKey, requestId: original.requestId ?? null,
        description: `refund of ${originalIdempotencyKey}`,
      });
    });
  }

  // ---- Budgets ----
  async setBudget(userId: string, input: Omit<BudgetLimit, 'id' | 'userId' | 'createdAt'> & { id?: string }): Promise<BudgetLimit> {
    return this.store.upsertBudget({ ...input, id: input.id ?? `budget-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, userId, createdAt: new Date().toISOString() });
  }
  listBudgets(userId: string) { return this.store.listBudgets(userId); }
  deleteBudget(id: string, userId: string) { return this.store.deleteBudget(id, userId); }

  /**
   * Pre-request budget enforcement. Throws BudgetExceededError when any
   * applicable budget would be exceeded by `amount`. Callers record the
   * spend afterwards via recordBudgetSpend (usage aggregation job also does).
   */
  async checkBudgets(userId: string, amount: number, ctx: { model?: string; provider?: string; apiKeyId?: string } = {}): Promise<void> {
    const budgets = await this.store.listBudgets(userId);
    for (const b of budgets) {
      let window = '';
      let key: string | null = null;
      switch (b.scope) {
        case 'DAILY': window = todayWindow(); break;
        case 'MONTHLY': window = monthWindow(); break;
        case 'PER_MODEL': window = todayWindow(); key = b.scopeKey ?? ctx.model ?? null; if (ctx.model && b.scopeKey && ctx.model !== b.scopeKey) continue; if (!key) continue; break;
        case 'PER_PROVIDER': window = todayWindow(); key = b.scopeKey ?? ctx.provider ?? null; if (ctx.provider && b.scopeKey && ctx.provider !== b.scopeKey) continue; if (!key) continue; break;
        case 'PER_KEY': window = todayWindow(); key = b.scopeKey ?? ctx.apiKeyId ?? null; if (ctx.apiKeyId && b.scopeKey && ctx.apiKeyId !== b.scopeKey) continue; if (!key) continue; break;
      }
      const usage = await this.store.getBudgetUsage(userId, b.scope, key, window);
      const used = usage?.usedCredits ?? 0;
      if (used + amount > b.limitCredits) throw new BudgetExceededError(b, used, amount);
    }
  }

  async recordBudgetSpend(userId: string, amount: number, ctx: { model?: string; provider?: string; apiKeyId?: string } = {}): Promise<void> {
    const add = async (scope: BudgetLimit['scope'], key: string | null, window: string) => {
      await this.store.addBudgetUsage({ userId, scope, scopeKey: key, window, usedCredits: round2(amount) });
    };
    await add('DAILY', null, todayWindow());
    await add('MONTHLY', null, monthWindow());
    if (ctx.model) await add('PER_MODEL', ctx.model, todayWindow());
    if (ctx.provider) await add('PER_PROVIDER', ctx.provider, todayWindow());
    if (ctx.apiKeyId) await add('PER_KEY', ctx.apiKeyId, todayWindow());
  }
}
