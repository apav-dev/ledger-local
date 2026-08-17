import { describe, expect, it } from 'vitest';
import { setAccountSynced, setItemCursor, upsertItem } from '../src/core/db.js';
import {
  authStatus,
  listAccounts,
  listTransactions,
  spendingSummary,
  unsyncedItemIds,
} from '../src/core/queries.js';
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
    const august = listTransactions(db, { from: '2026-08-01', to: '2026-08-31' }, () => NOW);
    expect(august.total).toBe(5);
    const acc2 = listTransactions(db, { accountId: 'acc_2' }, () => NOW);
    expect(acc2.transactions.map(t => t.id)).toEqual(['t6']);
    const costco = listTransactions(db, { search: 'costco' }, () => NOW);
    expect(costco.transactions.map(t => t.id)).toEqual(['t1']);
  });

  it('filters on the Plaid primary category', () => {
    const db = seedDb();
    const groceries = listTransactions(db, { category: 'GROCERIES' }, () => NOW);
    expect(groceries.transactions.map(t => t.id).sort()).toEqual(['t1', 't2']);
  });

  it('filters by pending status', () => {
    const db = seedDb();
    expect(listTransactions(db, { status: 'pending' }, () => NOW).transactions.map(t => t.id)).toEqual([
      't5',
    ]);
  });

  it('orders date DESC and respects limit/offset with total intact', () => {
    const db = seedDb();
    const page = listTransactions(db, { limit: 2, offset: 1 }, () => NOW);
    expect(page.total).toBe(6);
    expect(page.transactions).toHaveLength(2);
    const [first, second] = page.transactions;
    expect((first?.date ?? '') >= (second?.date ?? '')).toBe(true);
  });

  it('returns income as a negative amount', () => {
    // Plaid-native sign: the paycheck is negative, spending is positive.
    const db = seedDb();
    const income = listTransactions(db, { category: 'INCOME' }, () => NOW);
    expect(income.transactions[0]?.amount).toBe(-2000);
  });
});

describe('spendingSummary', () => {
  it('groups spend by category, excluding pending and inflows by default', () => {
    const db = seedDb();
    const { groups, grandTotal } = spendingSummary(
      db,
      { from: '2026-07-01', to: '2026-08-31', groupBy: 'category' },
      () => NOW,
    );
    // spend: GROCERIES 80, TRAVEL 40, FOOD_AND_DRINK 20.
    // t5 excluded (pending), t4 excluded (inflow, negative under Plaid signs).
    expect(grandTotal).toBe(140);
    expect(groups[0]).toMatchObject({ key: 'GROCERIES', total: 80, count: 2 });
    expect(groups[0]?.share).toBeCloseTo(80 / 140);
  });

  it('never reports a negative total even when inflows are included', () => {
    // Totals stay positive dollars so callers never reason about the sign.
    const db = seedDb();
    const { groups } = spendingSummary(
      db,
      { from: '2026-07-01', to: '2026-08-31', groupBy: 'category', includeInflows: true },
      () => NOW,
    );
    expect(groups.every(g => g.total > 0)).toBe(true);
    expect(groups.find(g => g.key === 'INCOME')?.total).toBe(2000);
  });

  it('excludes the paycheck from default spend', () => {
    const db = seedDb();
    const { groups } = spendingSummary(
      db,
      { from: '2026-07-01', to: '2026-08-31', groupBy: 'category' },
      () => NOW,
    );
    expect(groups.map(g => g.key)).not.toContain('INCOME');
  });

  it('groups by month and can include pending', () => {
    const db = seedDb();
    const { groups } = spendingSummary(
      db,
      { from: '2026-07-01', to: '2026-08-31', groupBy: 'month', includePending: true },
      () => NOW,
    );
    // August spend incl. pending: 50 + 30 + 99 + 40 = 219
    expect(groups.find(g => g.key === '2026-08')?.total).toBe(219);
    expect(groups.find(g => g.key === '2026-07')?.total).toBe(20);
  });

  it('groups merchants with unknown fallback', () => {
    const db = seedDb();
    const { groups } = spendingSummary(
      db,
      { from: '2026-07-01', to: '2026-08-31', groupBy: 'merchant' },
      () => NOW,
    );
    expect(groups.map(g => g.key)).toContain('Costco');
  });

  it('labels missing categories as UNCATEGORIZED', () => {
    const db = seedDb();
    db.prepare('UPDATE transactions SET category_primary = NULL WHERE id = ?').run('t1');
    const { groups } = spendingSummary(
      db,
      { from: '2026-07-01', to: '2026-08-31', groupBy: 'category' },
      () => NOW,
    );
    expect(groups.map(g => g.key)).toContain('UNCATEGORIZED');
  });

  it('returns zero shares rather than dividing by zero on an empty range', () => {
    const { groups, grandTotal } = spendingSummary(
      seedDb(),
      { from: '2020-01-01', to: '2020-01-31', groupBy: 'category' },
      () => NOW,
    );
    expect(groups).toEqual([]);
    expect(grandTotal).toBe(0);
  });
});

describe('authStatus', () => {
  it('reports items with account counts and sync state', () => {
    const status = authStatus(seedDb(), { environment: 'sandbox' });
    expect(status.environment).toBe('sandbox');
    expect(status.items).toEqual([
      { id: 'item_1', institution: 'Chase', accountCount: 2, synced: true },
    ]);
  });

  it('marks an item with no cursor as unsynced', () => {
    const db = seedDb();
    upsertItem(db, {
      id: 'item_2',
      access_token: 'tok2',
      institution: 'Amex',
      institution_id: 'ins_10',
      created_at: 2,
    });
    const status = authStatus(db, { environment: 'production' });
    expect(status.items.find(i => i.id === 'item_2')).toMatchObject({
      synced: false,
      accountCount: 0,
    });
    expect(unsyncedItemIds(db)).toEqual(['item_2']);
  });

  it('reports no unsynced items once every item has a cursor', () => {
    const db = seedDb();
    setItemCursor(db, 'item_1', 'c');
    expect(unsyncedItemIds(db)).toEqual([]);
  });
});
