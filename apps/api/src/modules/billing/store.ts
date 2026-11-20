// In-memory BillingStore — simulates atomic transactions with a per-wallet
// mutex so service-level idempotency / no-double-charge can be tested.
// Production MUST use Prisma $transaction; this store is tests + local dev.
import { randomUUID } from 'node:crypto';
import type { BillingStore, BudgetLimit, BudgetUsage, CreditTransaction, CreditWallet } from './service.js';

export class InMemoryBillingStore implements BillingStore {
  wallets = new Map<string, CreditWallet>();
  transactions: CreditTransaction[] = [];
  budgets = new Map<string, BudgetLimit>();
  usage = new Map<string, BudgetUsage>();
  private locks = new Map<string, Promise<unknown>>();

  async getWallet(userId: string) { return this.wallets.get(userId) ?? null; }
  async createWallet(userId: string, currency = 'USD') {
    const w: CreditWallet = { userId, balance: 0, currency };
    this.wallets.set(userId, w);
    return w;
  }

  async transact<T>(fn: () => Promise<T>): Promise<T> {
    // Single global lock is enough for the in-memory store (tests are serial).
    const prev = this.locks.get('global') ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((r) => { release = r; });
    this.locks.set('global', prev.then(() => next));
    await prev;
    try { return await fn(); } finally { release(); }
  }

  async applyTransaction(tx: Omit<CreditTransaction, 'id' | 'createdAt'>): Promise<CreditTransaction> {
    const wallet = this.wallets.get(tx.walletId);
    if (!wallet) throw new Error('wallet not found');
    if (this.transactions.some((t) => t.idempotencyKey === tx.idempotencyKey)) {
      throw new Error(`duplicate idempotency key: ${tx.idempotencyKey}`);
    }
    const row: CreditTransaction = { ...tx, id: randomUUID(), createdAt: new Date().toISOString() };
    wallet.balance = Math.round((wallet.balance + tx.amount) * 100) / 100;
    this.transactions.push(row);
    return row;
  }

  async findTransactionByIdempotencyKey(key: string) {
    return this.transactions.find((t) => t.idempotencyKey === key) ?? null;
  }

  async listTransactions(userId: string, limit = 50, offset = 0) {
    const rows = this.transactions.filter((t) => t.walletId === userId);
    return { rows: rows.slice(offset, offset + limit), total: rows.length };
  }

  async upsertBudget(b: BudgetLimit) { this.budgets.set(b.id, b); return b; }
  async listBudgets(userId: string) { return [...this.budgets.values()].filter((b) => b.userId === userId); }
  async deleteBudget(id: string, userId: string) {
    const b = this.budgets.get(id);
    if (!b || b.userId !== userId) return false;
    this.budgets.delete(id);
    return true;
  }

  async getBudgetUsage(userId: string, scope: BudgetLimit['scope'], scopeKey: string | null, window: string) {
    return this.usage.get(`${userId}|${scope}|${scopeKey ?? ''}|${window}`) ?? null;
  }

  async addBudgetUsage(u: BudgetUsage) {
    const key = `${u.userId}|${u.scope}|${u.scopeKey ?? ''}|${u.window}`;
    const existing = this.usage.get(key);
    if (existing) existing.usedCredits = Math.round((existing.usedCredits + u.usedCredits) * 100) / 100;
    else this.usage.set(key, { ...u });
  }
}
