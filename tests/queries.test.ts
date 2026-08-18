import { describe, expect, it } from 'vitest';
import { setAccountSynced, setItemConsent, setItemCursor, upsertItem } from '../src/core/db.js';
import {
  authStatus,
  listAccounts,
  listCategories,
  listTransactions,
  spendingSummary,
  unsyncedItemIds,
} from '../src/core/queries.js';
import { CONSENTED_PRODUCTS } from '../src/core/plaid-client.js';
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
    const amazon = listTransactions(db, { search: 'amazon' }, () => NOW);
    expect(amazon.transactions.map(t => t.id)).toEqual(['t1']);
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
    expect(income.transactions[0]?.amount_cents).toBe(-200_000);
  });

  it('matches category case-insensitively', () => {
    const db = seedDb();
    const groceries = listTransactions(db, { category: 'groceries' }, () => NOW);
    expect(groceries.transactions.map(t => t.id).sort()).toEqual(['t1', 't2']);
  });

  it('rejects an unknown category, listing the real ones', () => {
    const db = seedDb();
    expect(() => listTransactions(db, { category: 'NOT_REAL' }, () => NOW)).toThrow(/is not known/);
    expect(() => listTransactions(db, { category: 'NOT_REAL' }, () => NOW)).toThrow(/GROCERIES/);
  });

  it('filters UNCATEGORIZED to rows with no category', () => {
    const db = seedDb();
    db.prepare('UPDATE transactions SET category_primary = NULL WHERE id = ?').run('t1');
    const result = listTransactions(db, { category: 'uncategorized' }, () => NOW);
    expect(result.transactions.map(t => t.id)).toEqual(['t1']);
  });

  it('rejects a garbage date instead of silently returning empty', () => {
    const db = seedDb();
    expect(() => listTransactions(db, { from: '2026-13-45' }, () => NOW)).toThrow(/not a valid date/);
    expect(() => listTransactions(db, { to: 'last month' }, () => NOW)).toThrow(/not a valid date/);
  });

  it('rejects an inverted date range', () => {
    const db = seedDb();
    expect(() =>
      listTransactions(db, { from: '2026-08-31', to: '2026-08-01' }, () => NOW),
    ).toThrow(/must not be after/);
  });

  it('resolves relative date keywords', () => {
    const db = seedDb();
    // NOW = 2026-08-17, so this-month starts 2026-08-01, matching the August rows.
    const result = listTransactions(db, { from: 'this-month', to: 'today' }, () => NOW);
    expect(result.total).toBe(5);
  });
});

describe('listCategories', () => {
  it('returns distinct categories with counts', () => {
    const db = seedDb();
    const { categories } = listCategories(db, () => NOW);
    expect(categories.map(c => c.category).sort()).toEqual([
      'FOOD_AND_DRINK',
      'GROCERIES',
      'INCOME',
      'TRAVEL',
    ]);
    expect(categories.find(c => c.category === 'GROCERIES')).toMatchObject({ count: 2 });
  });

  it('includes UNCATEGORIZED for null-category rows', () => {
    const db = seedDb();
    db.prepare('UPDATE transactions SET category_primary = NULL WHERE id = ?').run('t1');
    const { categories } = listCategories(db, () => NOW);
    expect(categories.find(c => c.category === 'UNCATEGORIZED')).toMatchObject({ count: 1 });
  });

  it('returns empty with fresh meta on an empty database', () => {
    const db = seedDb();
    db.prepare('DELETE FROM transactions').run();
    const { categories } = listCategories(db, () => NOW);
    expect(categories).toEqual([]);
  });
});

describe('spendingSummary', () => {
  it('groups spend by category, excluding pending and inflows by default', () => {
    const db = seedDb();
    const { groups, grandTotalCents } = spendingSummary(
      db,
      { from: '2026-07-01', to: '2026-08-31', groupBy: 'category' },
      () => NOW,
    );
    // spend: GROCERIES $80, TRAVEL $40, FOOD_AND_DRINK $20.
    // t5 excluded (pending), t4 excluded (inflow, negative under Plaid signs).
    expect(grandTotalCents).toBe(14_000);
    expect(groups[0]).toMatchObject({ key: 'GROCERIES', totalCents: 8000, count: 2 });
    expect(groups[0]?.share).toBeCloseTo(80 / 140);
  });

  it('sums cents exactly, with no float drift', () => {
    // The representational payoff: an integer SUM cannot accumulate error, so
    // the total is exact rather than merely close.
    const db = seedDb();
    db.prepare('UPDATE transactions SET amount_cents = 1234 WHERE status = ?').run('posted');
    const { grandTotalCents } = spendingSummary(
      db,
      { from: '2026-07-01', to: '2026-08-31', groupBy: 'category', includeInflows: true },
      () => NOW,
    );
    // 5 posted rows at 1234 cents each. Exactly, not 6169.999999999999.
    expect(grandTotalCents).toBe(6170);
    expect(Number.isInteger(grandTotalCents)).toBe(true);
  });

  it('never reports a negative total even when inflows are included', () => {
    // Totals stay positive dollars so callers never reason about the sign.
    const db = seedDb();
    const { groups } = spendingSummary(
      db,
      { from: '2026-07-01', to: '2026-08-31', groupBy: 'category', includeInflows: true },
      () => NOW,
    );
    expect(groups.every(g => g.totalCents > 0)).toBe(true);
    expect(groups.find(g => g.key === 'INCOME')?.totalCents).toBe(200_000);
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
    // August spend incl. pending: $50 + $30 + $99 + $40 = $219
    expect(groups.find(g => g.key === '2026-08')?.totalCents).toBe(21_900);
    expect(groups.find(g => g.key === '2026-07')?.totalCents).toBe(2000);
  });

  it('groups merchants with unknown fallback', () => {
    const db = seedDb();
    const { groups } = spendingSummary(
      db,
      { from: '2026-07-01', to: '2026-08-31', groupBy: 'merchant' },
      () => NOW,
    );
    // The display label is any name from the bucket; the guarantee is that
    // variants collapse, not which variant wins. In real Plaid data this rarely
    // bites because counterparty comes from merchant_name, which Plaid has
    // already normalised — the seed's two spellings are a deliberately harsh case.
    const amazon = groups.filter(g => g.key === 'Amazon' || g.key === 'AMZN Mktp US');
    expect(amazon).toHaveLength(1);
    expect(amazon[0]?.count).toBe(2);
    expect(amazon[0]?.totalCents).toBe(8000);
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
    const { groups, grandTotalCents } = spendingSummary(
      seedDb(),
      { from: '2020-01-01', to: '2020-01-31', groupBy: 'category' },
      () => NOW,
    );
    expect(groups).toEqual([]);
    expect(grandTotalCents).toBe(0);
  });

  it('rejects a garbage date instead of silently returning a zero total', () => {
    const db = seedDb();
    expect(() =>
      spendingSummary(db, { from: '2026-13-45', to: 'today', groupBy: 'category' }, () => NOW),
    ).toThrow(/not a valid date/);
    expect(() =>
      spendingSummary(db, { from: 'last month', to: 'today', groupBy: 'category' }, () => NOW),
    ).toThrow(/not a valid date/);
  });

  it('rejects an inverted date range instead of silently returning a zero total', () => {
    const db = seedDb();
    expect(() =>
      spendingSummary(db, { from: '2026-08-31', to: '2026-08-01', groupBy: 'category' }, () => NOW),
    ).toThrow(/must not be after/);
  });

  it('resolves relative date keywords', () => {
    const db = seedDb();
    // NOW = 2026-08-17. this-month..today covers 2026-08-01..2026-08-17: posted,
    // non-inflow rows t1 ($50), t2 ($30), t6 ($40) — t4 is an inflow, t5 is pending.
    const { grandTotalCents } = spendingSummary(
      db,
      { from: 'this-month', to: 'today', groupBy: 'category' },
      () => NOW,
    );
    expect(grandTotalCents).toBe(12_000);
  });
});

describe('merchant grouping', () => {
  it('collapses name variants that share a merchant entity id', () => {
    const db = seedDb();

    const { groups } = spendingSummary(
      db,
      { from: '2026-08-01', to: '2026-08-31', groupBy: 'merchant' },
      () => NOW,
    );

    const amazon = groups.filter(g => g.key === 'Amazon' || g.key === 'AMZN Mktp US');
    expect(amazon).toHaveLength(1);
    expect(amazon[0]?.count).toBe(2);
    expect(amazon[0]?.totalCents).toBe(8000);
  });

  it('still groups by name when no entity id is present', () => {
    const db = seedDb();

    const { groups } = spendingSummary(
      db,
      { from: '2026-07-01', to: '2026-07-31', groupBy: 'merchant' },
      () => NOW,
    );

    expect(groups.map(g => g.key)).toContain('Blue Bottle');
  });
});

describe('payment_channel grouping', () => {
  it('totals spending by channel', () => {
    const db = seedDb();

    const { groups } = spendingSummary(
      db,
      { from: '2026-08-01', to: '2026-08-31', groupBy: 'payment_channel' },
      () => NOW,
    );

    const online = groups.find(g => g.key === 'online');
    expect(online?.totalCents).toBe(8000);
    expect(online?.count).toBe(2);
  });
});

describe('search', () => {
  it('matches the raw bank memo as well as the cleaned description', () => {
    const db = seedDb();

    const { transactions } = listTransactions(db, { search: 'AMZN MKTP US*2K4' }, () => NOW);

    expect(transactions.map(t => t.id)).toEqual(['t2']);
  });
});

describe('authStatus', () => {
  it('reports items with account counts and sync state', () => {
    const status = authStatus(seedDb(), { environment: 'sandbox' });
    expect(status.environment).toBe('sandbox');
    expect(status.items).toEqual([
      {
        id: 'item_1',
        institution: 'Chase',
        accountCount: 2,
        synced: true,
        consented: [],
        consentUpToDate: false,
      },
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
      consented_products: null,
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

describe('authStatus consent', () => {
  it('reports consent as out of date when the item predates the current set', () => {
    const db = seedDb();

    const status = authStatus(db, { environment: 'sandbox' });

    expect(status.items[0]?.consented).toEqual([]);
    expect(status.items[0]?.consentUpToDate).toBe(false);
  });

  it('reports consent as up to date once every current product is recorded', () => {
    const db = seedDb();
    setItemConsent(db, 'item_1', [...CONSENTED_PRODUCTS]);

    const status = authStatus(db, { environment: 'sandbox' });

    expect(status.items[0]?.consentUpToDate).toBe(true);
  });

  it('treats a superset as up to date', () => {
    const db = seedDb();
    setItemConsent(db, 'item_1', [...CONSENTED_PRODUCTS, 'auth']);

    const status = authStatus(db, { environment: 'sandbox' });

    expect(status.items[0]?.consentUpToDate).toBe(true);
  });
});
