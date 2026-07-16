import { describe, expect, it } from 'vitest';
import { setAccountSynced } from '../src/core/db.js';
import { listAccounts, listTransactions, spendingSummary } from '../src/core/queries.js';
import { NOW, seedDb } from './helpers.js';

describe('listAccounts', () => {
  it('returns accounts with fresh meta', () => {
    const { accounts, meta } = listAccounts(seedDb(), () => NOW);
    expect(accounts).toHaveLength(2);
    expect(meta.stale).toBe(false);
    expect(meta.last_synced_at).toBe(NOW - 60_000);
  });

  it('flags stale when oldest sync exceeds 24h', () => {
    const db = seedDb();
    setAccountSynced(db, 'acc_2', NOW - 25 * 3600 * 1000);
    expect(listAccounts(db, () => NOW).meta.stale).toBe(true);
  });
});

describe('listTransactions', () => {
  it('filters by date range, account, and text search', () => {
    const db = seedDb();
    const july = listTransactions(db, { from: '2026-07-01', to: '2026-07-31' }, () => NOW);
    expect(july.total).toBe(5);
    const acc2 = listTransactions(db, { accountId: 'acc_2' }, () => NOW);
    expect(acc2.transactions.map(t => t.id)).toEqual(['t6']);
    const costco = listTransactions(db, { search: 'costco' }, () => NOW);
    expect(costco.transactions.map(t => t.id)).toEqual(['t1']);
  });

  it('orders date DESC and respects limit/offset with total intact', () => {
    const db = seedDb();
    const page = listTransactions(db, { limit: 2, offset: 1 }, () => NOW);
    expect(page.total).toBe(6);
    expect(page.transactions).toHaveLength(2);
    expect(page.transactions[0]?.date! >= page.transactions[1]?.date!).toBe(true);
  });
});

describe('spendingSummary', () => {
  it('groups spend by category, excluding pending and inflows by default', () => {
    const db = seedDb();
    const { groups, grandTotal } = spendingSummary(
      db,
      { from: '2026-06-01', to: '2026-07-31', groupBy: 'category' },
      () => NOW,
    );
    // spend: groceries 80, travel 40, dining 20 (t5 pending excluded, t4 inflow excluded)
    expect(grandTotal).toBe(140);
    expect(groups[0]).toMatchObject({ key: 'groceries', total: 80, count: 2 });
    expect(groups[0]?.share).toBeCloseTo(80 / 140);
  });

  it('groups by month and can include pending', () => {
    const db = seedDb();
    const { groups } = spendingSummary(
      db,
      { from: '2026-06-01', to: '2026-07-31', groupBy: 'month', includePending: true },
      () => NOW,
    );
    const july = groups.find(g => g.key === '2026-07');
    expect(july?.total).toBe(219); // 50+30+99+40
  });

  it('groups merchants with unknown fallback', () => {
    const db = seedDb();
    const { groups } = spendingSummary(
      db,
      { from: '2026-06-01', to: '2026-07-31', groupBy: 'merchant' },
      () => NOW,
    );
    expect(groups.map(g => g.key)).toContain('Costco');
  });
});
