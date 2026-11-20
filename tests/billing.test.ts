// Billing tests — Vitest + Fastify inject + mocked (in-memory) store.
// NO live DB/Redis. Atomicity/idempotency are verified at service level
// against the in-memory store, which serialises transactions; production
// must use Prisma $transaction for the same guarantee.
import { describe, it, expect, beforeEach } from 'vitest';
import { BillingService, BudgetExceededError, InsufficientBalanceError } from '../apps/api/src/modules/billing/service.js';
import { InMemoryBillingStore } from '../apps/api/src/modules/billing/store.js';
import { buildApp, asUser, asAdmin, userA, userB } from './helpers.js';

describe('BillingService — wallet & ledger', () => {
  let store: InMemoryBillingStore;
  let svc: BillingService;
  beforeEach(() => { store = new InMemoryBillingStore(); svc = new BillingService(store); });

  it('purchase tops up and adjust is admin-visible in the ledger', async () => {
    await svc.purchase(userA, 10, 'purchase-1');
    expect((await svc.getWallet(userA)).balance).toBe(10);
    await svc.adjust(userA, 5, 'adjust-1', 'goodwill');
    expect((await svc.getWallet(userA)).balance).toBe(15);
    const txs = await svc.listTransactions(userA);
    expect(txs.total).toBe(2);
    expect(txs.rows.map((t) => t.type)).toEqual(['PURCHASE', 'ADJUSTMENT']);
  });

  it('(c) atomic debit + duplicate idempotency key does NOT double-charge', async () => {
    await svc.purchase(userA, 10, 'purchase-1');
    const first = await svc.debit(userA, 2.5, 'req-1', { requestId: 'r1' });
    expect(first).not.toBeNull();
    expect((await svc.getWallet(userA)).balance).toBe(7.5);
    // Same key again → same transaction, balance unchanged.
    const second = await svc.debit(userA, 2.5, 'req-1', { requestId: 'r1' });
    expect(second!.id).toBe(first!.id);
    expect((await svc.getWallet(userA)).balance).toBe(7.5);
    expect((await svc.listTransactions(userA)).total).toBe(2); // purchase + 1 debit
    // Concurrent duplicate debits also collapse to one charge.
    await svc.purchase(userA, 10, 'purchase-2');
    const results = await Promise.allSettled([
      svc.debit(userA, 3, 'req-race', { requestId: 'r2' }),
      svc.debit(userA, 3, 'req-race', { requestId: 'r2' }),
      svc.debit(userA, 3, 'req-race', { requestId: 'r2' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    expect((await svc.getWallet(userA)).balance).toBe(14.5); // 17.5 - 3 once
  });

  it('insufficient balance blocks the debit and leaves the ledger untouched', async () => {
    await svc.purchase(userA, 1, 'purchase-1');
    await expect(svc.debit(userA, 5, 'req-1')).rejects.toBeInstanceOf(InsufficientBalanceError);
    expect((await svc.getWallet(userA)).balance).toBe(1);
    expect((await svc.listTransactions(userA)).total).toBe(1);
  });

  it('BYOK mode never charges platform credits', async () => {
    await svc.purchase(userA, 5, 'purchase-1');
    const tx = await svc.debit(userA, 2, 'req-byok', { mode: 'BYOK' });
    expect(tx).toBeNull();
    expect((await svc.getWallet(userA)).balance).toBe(5);
    expect((await svc.listTransactions(userA)).total).toBe(1);
  });

  it('refund returns credit and is idempotent', async () => {
    await svc.purchase(userA, 10, 'purchase-1');
    await svc.debit(userA, 4, 'req-1', { requestId: 'r1' });
    const refund = await svc.refund(userA, 'req-1', 'refund-1');
    expect(refund.type).toBe('REFUND');
    expect(refund.amount).toBe(4);
    expect((await svc.getWallet(userA)).balance).toBe(10);
    const again = await svc.refund(userA, 'req-1', 'refund-1');
    expect(again.id).toBe(refund.id);
    expect((await svc.getWallet(userA)).balance).toBe(10);
  });

  it('partial refund only returns the requested amount', async () => {
    await svc.purchase(userA, 10, 'purchase-1');
    await svc.debit(userA, 4, 'req-1');
    await svc.refund(userA, 'req-1', 'refund-1', 1.5);
    expect((await svc.getWallet(userA)).balance).toBe(7.5);
  });
});

describe('BillingService — budgets', () => {
  let store: InMemoryBillingStore;
  let svc: BillingService;
  beforeEach(() => { store = new InMemoryBillingStore(); svc = new BillingService(store); });

  it('(d) budget exceeded blocks the request', async () => {
    await svc.setBudget(userA, { scope: 'DAILY', limitCredits: 5 });
    await svc.recordBudgetSpend(userA, 4);
    await expect(svc.checkBudgets(userA, 2)).rejects.toBeInstanceOf(BudgetExceededError);
    await svc.checkBudgets(userA, 1); // exactly at the limit is allowed
  });

  it('per-model and per-provider budgets are scoped independently', async () => {
    await svc.setBudget(userA, { scope: 'PER_MODEL', scopeKey: 'gpt-6-luna', limitCredits: 2 });
    await svc.setBudget(userA, { scope: 'PER_PROVIDER', scopeKey: 'deepseek', limitCredits: 2 });
    await svc.recordBudgetSpend(userA, 2, { model: 'gpt-6-luna', provider: 'tokens' });
    await expect(svc.checkBudgets(userA, 0.5, { model: 'gpt-6-luna' })).rejects.toBeInstanceOf(BudgetExceededError);
    // A different model on the same provider is fine; deepseek provider budget untouched.
    await svc.checkBudgets(userA, 0.5, { model: 'kimi-k2.7-code', provider: 'deepseek' });
  });

  it('per-key budget blocks only that API key', async () => {
    await svc.setBudget(userA, { scope: 'PER_KEY', scopeKey: 'key-1', limitCredits: 1 });
    await svc.recordBudgetSpend(userA, 1, { apiKeyId: 'key-1' });
    await expect(svc.checkBudgets(userA, 0.1, { apiKeyId: 'key-1' })).rejects.toBeInstanceOf(BudgetExceededError);
    await svc.checkBudgets(userA, 0.1, { apiKeyId: 'key-2' });
  });

  it('monthly budget uses the month window', async () => {
    await svc.setBudget(userA, { scope: 'MONTHLY', limitCredits: 100 });
    await svc.recordBudgetSpend(userA, 99);
    await expect(svc.checkBudgets(userA, 2)).rejects.toBeInstanceOf(BudgetExceededError);
  });
});

describe('billing HTTP routes', () => {
  it('wallet + adjust (admin-only) + budgets endpoints', async () => {
    const { app, billingStore } = buildApp();
    // Wallet starts at 0.
    expect(JSON.parse((await app.inject({ method: 'GET', url: '/api/v1/credits/wallet', headers: asUser(userA) })).body).balance).toBe(0);
    // Non-admin cannot adjust.
    expect((await app.inject({ method: 'POST', url: '/api/v1/credits/adjust', headers: asUser(userA), payload: { targetUserId: userA, amount: 10, idempotencyKey: 'adj-1' } })).statusCode).toBe(403);
    // Admin adjusts.
    const adj = await app.inject({ method: 'POST', url: '/api/v1/credits/adjust', headers: asAdmin(userA), payload: { targetUserId: userA, amount: 10, idempotencyKey: 'adj-1' } });
    expect(adj.statusCode).toBe(201);
    expect(JSON.parse((await app.inject({ method: 'GET', url: '/api/v1/credits/wallet', headers: asUser(userA) })).body).balance).toBe(10);
    // Same idempotency key → same tx, no double credit.
    const adj2 = await app.inject({ method: 'POST', url: '/api/v1/credits/adjust', headers: asAdmin(userA), payload: { targetUserId: userA, amount: 10, idempotencyKey: 'adj-1' } });
    expect(JSON.parse(adj2.body).id).toBe(JSON.parse(adj.body).id);
    expect(JSON.parse((await app.inject({ method: 'GET', url: '/api/v1/credits/wallet', headers: asUser(userA) })).body).balance).toBe(10);
    // Transactions are user-scoped.
    const txsB = await app.inject({ method: 'GET', url: '/api/v1/credits/transactions', headers: asUser(userB) });
    expect(JSON.parse(txsB.body).total).toBe(0);
    // Budgets: create, check blocks, delete.
    const svc = new BillingService(billingStore);
    await svc.setBudget(userA, { scope: 'DAILY', limitCredits: 5 });
    await svc.recordBudgetSpend(userA, 5);
    const check = await app.inject({ method: 'POST', url: '/api/v1/budgets/check', headers: asUser(userA), payload: { amount: 1 } });
    expect(check.statusCode).toBe(402);
    const budgets = JSON.parse((await app.inject({ method: 'GET', url: '/api/v1/budgets', headers: asUser(userA) })).body);
    expect(budgets).toHaveLength(1);
    const del = await app.inject({ method: 'DELETE', url: `/api/v1/budgets/${budgets[0].id}`, headers: asUser(userA) });
    expect(del.statusCode).toBe(204);
  });
});
