import { describe, expect, it } from 'vitest';
import type { AccountRow } from '../src/core/db.js';
import type { QueryMeta } from '../src/core/queries.js';
import {
  accountsResultView,
  leanTransactionView,
  spendingResultView,
  transactionView,
  transactionsResultView,
} from '../src/core/views.js';
import { NOW, fullTransactionRow } from './helpers.js';

const META: QueryMeta = { last_synced_at: NOW, stale: false };

function accountRow(over: Partial<AccountRow> & Pick<AccountRow, 'id'>): AccountRow {
  return {
    item_id: 'item_1',
    name: 'Checking',
    official_name: null,
    institution: 'Chase',
    type: 'depository',
    subtype: 'checking',
    mask: '1111',
    iso_currency_code: 'USD',
    available_balance_cents: 50_000,
    current_balance_cents: 50_000,
    last_synced_at: NOW,
    ...over,
  };
}

/** Recursively collects every key name appearing anywhere in a JSON value. */
function allKeys(value: unknown, found: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) allKeys(item, found);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      found.add(key);
      allKeys(child, found);
    }
  }
  return found;
}

describe('accountsResultView', () => {
  it('converts balances to dollars under their original field names', () => {
    const view = accountsResultView({
      accounts: [accountRow({ id: 'acc_1' })],
      meta: META,
    });
    const checking = view.accounts.find(a => a.id === 'acc_1');
    expect(checking?.available_balance).toBe(500);
    expect(checking?.current_balance).toBe(500);
  });

  it('keeps a negative balance negative', () => {
    // A credit card carries a negative balance; the view must not take abs.
    const view = accountsResultView({
      accounts: [
        accountRow({
          id: 'acc_2',
          name: 'Card',
          type: 'credit',
          subtype: 'credit card',
          available_balance_cents: -20_000,
          current_balance_cents: -20_000,
        }),
      ],
      meta: META,
    });
    expect(view.accounts.find(a => a.id === 'acc_2')?.current_balance).toBe(-200);
  });

  it('passes meta through untouched', () => {
    const result = { accounts: [accountRow({ id: 'acc_1' })], meta: META };
    expect(accountsResultView(result).meta).toEqual(result.meta);
  });
});

describe('transactionsResultView', () => {
  it('converts amounts to dollars and preserves the Plaid sign', () => {
    const view = transactionsResultView({
      transactions: [
        fullTransactionRow({ id: 't1', amount_cents: 5000 }),
        fullTransactionRow({ id: 't4', amount_cents: -200_000 }),
      ],
      total: 2,
      meta: META,
    });
    const byId = new Map(view.transactions.map(t => [t.id, t.amount]));
    expect(byId.get('t1')).toBe(50); // spend stays positive
    expect(byId.get('t4')).toBe(-2000); // income stays negative
  });

  it('preserves the total count alongside the paginated rows', () => {
    const view = transactionsResultView({
      transactions: [
        fullTransactionRow({ id: 't1' }),
        fullTransactionRow({ id: 't2' }),
      ],
      total: 6,
      meta: META,
    });
    expect(view.transactions).toHaveLength(2);
    expect(view.total).toBe(6);
  });

  it('passes every stored field through to the full view, converting only the amount', () => {
    const row = fullTransactionRow();

    const view = transactionView(row);

    // Compare against the row itself rather than listing 44 assertions: a field
    // dropped from transactionView shows up here, a hand-written list would miss it.
    const { amount_cents, ...rest } = row;
    expect(view).toEqual({ ...rest, amount: 4.5 });
    expect('amount_cents' in view).toBe(false);
  });

  it('lean view carries the fields an agent reasons with and nothing else', () => {
    const view = leanTransactionView(fullTransactionRow());

    expect(Object.keys(view).sort()).toEqual(
      [
        'account_id', 'amount', 'authorized_date', 'category_confidence',
        'category_detailed', 'category_primary', 'counterparty', 'counterparty_type',
        'date', 'description', 'id', 'iso_currency_code', 'merchant_entity_id',
        'payment_channel', 'status',
      ].sort(),
    );
    expect(view.amount).toBe(4.5);
  });

  it('lean view drops the bulky fields', () => {
    const view = leanTransactionView(fullTransactionRow()) as Record<string, unknown>;

    for (const dropped of [
      'counterparties_json', 'logo_url', 'category_icon_url', 'location_address',
      'payment_meta_reference_number', 'original_description',
    ]) {
      expect(view).not.toHaveProperty(dropped);
    }
  });

  it('transactionsResultView is lean by default and full under verbose', () => {
    const result = { transactions: [fullTransactionRow()], total: 1, meta: { last_synced_at: NOW, stale: false } };

    const lean = transactionsResultView(result);
    const verbose = transactionsResultView(result, { verbose: true });

    expect(lean.transactions[0]).not.toHaveProperty('counterparties_json');
    expect(verbose.transactions[0]).toHaveProperty('counterparties_json');
    expect(lean.total).toBe(1);
    expect(verbose.total).toBe(1);
  });
});

describe('spendingResultView', () => {
  it('converts group totals and the grand total to dollars', () => {
    const view = spendingResultView({
      groups: [
        { key: 'GROCERIES', totalCents: 8000, count: 2, share: 80 / 140 },
        { key: 'FOOD_AND_DRINK', totalCents: 2000, count: 1, share: 20 / 140 },
        { key: 'TRAVEL', totalCents: 4000, count: 1, share: 40 / 140 },
      ],
      grandTotalCents: 14_000,
      meta: META,
    });
    expect(view.grandTotal).toBe(140);
    expect(view.groups.find(g => g.key === 'GROCERIES')?.total).toBe(80);
  });

  it('leaves share as the ratio it already was', () => {
    const view = spendingResultView({
      groups: [{ key: 'GROCERIES', totalCents: 8000, count: 2, share: 80 / 140 }],
      grandTotalCents: 14_000,
      meta: META,
    });
    expect(view.groups.find(g => g.key === 'GROCERIES')?.share).toBeCloseTo(80 / 140);
  });
});

describe('no cent-denominated field escapes a view', () => {
  // The whole point of boundary B: a caller must never see a cents field and
  // misread 4599 as $4,599. This fails if a new column is added without being
  // mapped, which is the realistic way the boundary would leak.
  const cases: Array<[string, unknown]> = [
    [
      'accounts',
      accountsResultView({ accounts: [accountRow({ id: 'acc_1' })], meta: META }),
    ],
    [
      'transactions',
      transactionsResultView({
        transactions: [fullTransactionRow()],
        total: 1,
        meta: META,
      }),
    ],
    [
      'spending',
      spendingResultView({
        groups: [{ key: 'GROCERIES', totalCents: 8000, count: 2, share: 1 }],
        grandTotalCents: 8000,
        meta: META,
      }),
    ],
  ];

  for (const [name, view] of cases) {
    it(`${name} exposes no _cents or Cents key`, () => {
      const leaked = [...allKeys(view)].filter(k => /cents/i.test(k));
      expect(leaked).toEqual([]);
    });
  }
});
