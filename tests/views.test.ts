import { describe, expect, it } from 'vitest';
import { listAccounts, listTransactions, spendingSummary } from '../src/core/queries.js';
import {
  accountsResultView,
  spendingResultView,
  transactionsResultView,
} from '../src/core/views.js';
import { NOW, seedDb } from './helpers.js';

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
    const view = accountsResultView(listAccounts(seedDb(), () => NOW));
    const checking = view.accounts.find(a => a.id === 'acc_1');
    expect(checking?.available_balance).toBe(500);
    expect(checking?.current_balance).toBe(500);
  });

  it('keeps a negative balance negative', () => {
    // A credit card carries a negative balance; the view must not take abs.
    const view = accountsResultView(listAccounts(seedDb(), () => NOW));
    expect(view.accounts.find(a => a.id === 'acc_2')?.current_balance).toBe(-200);
  });

  it('passes meta through untouched', () => {
    const result = listAccounts(seedDb(), () => NOW);
    expect(accountsResultView(result).meta).toEqual(result.meta);
  });
});

describe('transactionsResultView', () => {
  it('converts amounts to dollars and preserves the Plaid sign', () => {
    const view = transactionsResultView(listTransactions(seedDb(), {}, () => NOW));
    const byId = new Map(view.transactions.map(t => [t.id, t.amount]));
    expect(byId.get('t1')).toBe(50); // spend stays positive
    expect(byId.get('t4')).toBe(-2000); // income stays negative
  });

  it('preserves the total count alongside the paginated rows', () => {
    const view = transactionsResultView(listTransactions(seedDb(), { limit: 2 }, () => NOW));
    expect(view.transactions).toHaveLength(2);
    expect(view.total).toBe(6);
  });
});

describe('spendingResultView', () => {
  it('converts group totals and the grand total to dollars', () => {
    const view = spendingResultView(
      spendingSummary(seedDb(), { from: '2026-07-01', to: '2026-08-31', groupBy: 'category' }, () => NOW),
    );
    expect(view.grandTotal).toBe(140);
    expect(view.groups.find(g => g.key === 'GROCERIES')?.total).toBe(80);
  });

  it('leaves share as the ratio it already was', () => {
    const view = spendingResultView(
      spendingSummary(seedDb(), { from: '2026-07-01', to: '2026-08-31', groupBy: 'category' }, () => NOW),
    );
    expect(view.groups.find(g => g.key === 'GROCERIES')?.share).toBeCloseTo(80 / 140);
  });
});

describe('no cent-denominated field escapes a view', () => {
  // The whole point of boundary B: a caller must never see a cents field and
  // misread 4599 as $4,599. This fails if a new column is added without being
  // mapped, which is the realistic way the boundary would leak.
  const cases: Array<[string, unknown]> = [
    ['accounts', accountsResultView(listAccounts(seedDb(), () => NOW))],
    ['transactions', transactionsResultView(listTransactions(seedDb(), {}, () => NOW))],
    [
      'spending',
      spendingResultView(
        spendingSummary(
          seedDb(),
          { from: '2026-07-01', to: '2026-08-31', groupBy: 'category' },
          () => NOW,
        ),
      ),
    ],
  ];

  for (const [name, view] of cases) {
    it(`${name} exposes no _cents or Cents key`, () => {
      const leaked = [...allKeys(view)].filter(k => /cents/i.test(k));
      expect(leaked).toEqual([]);
    });
  }
});
