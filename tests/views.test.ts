import { describe, expect, it } from 'vitest';
import type { AccountRow, CreditAprRow, CreditLiabilityRow, MortgageLiabilityRow } from '../src/core/db.js';
import type { QueryMeta } from '../src/core/queries.js';
import {
  accountsResultView,
  aprView,
  creditView,
  leanTransactionView,
  liabilitiesResultView,
  mortgageView,
  recurringStreamView,
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
    limit_cents: null,
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
    expect(checking?.limit).toBeNull();
  });

  it('converts limit_cents to dollars under limit, not through a percentage path', () => {
    const view = accountsResultView({
      accounts: [accountRow({ id: 'acc_2', type: 'credit', limit_cents: 500_000 })],
      meta: META,
    });
    expect(view.accounts[0]?.limit).toBe(5000);
    expect(view.accounts[0]).not.toHaveProperty('limit_cents');
  });

  it('keeps a negative balance negative', () => {
    // Views convert scale, never sign. A negative input must not be abs'd,
    // regardless of account type.
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

describe('recurringStreamView', () => {
  const row = {
    stream_id: 's1', item_id: 'item_1', account_id: 'acc_1', direction: 'outflow',
    description: 'NETFLIX', merchant_name: 'Netflix',
    category_primary: 'ENTERTAINMENT', category_detailed: 'ENTERTAINMENT_STREAMING',
    frequency: 'MONTHLY', status: 'MATURE', is_active: 1,
    first_date: '2026-01-15', last_date: '2026-08-15', predicted_next_date: '2026-09-15',
    average_amount_cents: 1599, last_amount_cents: 1799, transaction_count: 8,
    refreshed_at: 1000,
  };

  it('converts cents to dollars and the integer flag to a boolean', () => {
    const view = recurringStreamView(row);

    expect(view.average_amount).toBe(15.99);
    expect(view.last_amount).toBe(17.99);
    expect(view.is_active).toBe(true);
    expect('average_amount_cents' in view).toBe(false);
    expect('is_active' in view && typeof view.is_active).toBe('boolean');
  });

  it('keeps a null amount null rather than reporting zero', () => {
    const view = recurringStreamView({
      ...row, average_amount_cents: null, last_amount_cents: null,
    });

    expect(view.average_amount).toBeNull();
    expect(view.last_amount).toBeNull();
  });

  it('maps is_active 0 to false', () => {
    expect(recurringStreamView({ ...row, is_active: 0 }).is_active).toBe(false);
  });
});

function mortgageRow(over: Partial<MortgageLiabilityRow> = {}): MortgageLiabilityRow {
  return {
    account_id: 'acc_loan',
    item_id: 'item_1',
    refreshed_at: 1000,
    interest_rate_percentage: 6.125,
    interest_rate_type: 'fixed',
    escrow_balance_cents: 250_000,
    current_late_fee_cents: null,
    has_pmi: 0,
    has_prepayment_penalty: null,
    last_payment_amount_cents: 210_000,
    last_payment_date: '2026-08-01',
    loan_type_description: 'conventional',
    loan_term: '30 year',
    maturity_date: '2054-05-01',
    next_monthly_payment_cents: 210_000,
    next_payment_due_date: '2026-09-01',
    origination_date: '2024-05-01',
    origination_principal_amount_cents: 40_000_000,
    past_due_amount_cents: null,
    property_street: '1 Main St',
    property_city: 'Austin',
    property_region: 'TX',
    property_postal_code: '78701',
    property_country: 'US',
    ytd_interest_paid_cents: 800_000,
    ytd_principal_paid_cents: 400_000,
    ...over,
  };
}

describe('mortgageView', () => {
  it('converts cents to dollars and passes 6.125 through as a percentage', () => {
    const view = mortgageView(
      mortgageRow(),
      accountRow({ id: 'acc_loan', type: 'loan', current_balance_cents: 30_000_000 }),
    );

    expect(view.interest_rate_percentage).toBe(6.125);
    expect(view.escrow_balance).toBe(2500);
    expect(view.next_monthly_payment).toBe(2100);
    expect(view.outstanding_principal).toBe(300_000);
    expect(view.has_pmi).toBe(false);
    expect(view.has_prepayment_penalty).toBeNull();
    expect(view).not.toHaveProperty('escrow_balance_cents');
    expect(view).not.toHaveProperty('outstanding_principal_cents');
  });

  it('does not derive outstanding principal from origination', () => {
    const view = mortgageView(mortgageRow(), undefined);
    expect(view.outstanding_principal).toBeNull();
    expect(view.origination_principal_amount).toBe(400_000);
  });

  it('treats unreported PMI as null, not false', () => {
    expect(mortgageView(mortgageRow({ has_pmi: null }), undefined).has_pmi).toBeNull();
    expect(mortgageView(mortgageRow({ has_pmi: 1 }), undefined).has_pmi).toBe(true);
    expect(mortgageView(mortgageRow({ has_pmi: 0 }), undefined).has_pmi).toBe(false);
  });
});

describe('creditView and aprView', () => {
  const credit: CreditLiabilityRow = {
    account_id: 'acc_2',
    item_id: 'item_1',
    refreshed_at: 1000,
    is_overdue: 0,
    last_payment_amount_cents: 15_000,
    last_payment_date: '2026-08-05',
    last_statement_issue_date: '2026-08-01',
    last_statement_balance_cents: 80_000,
    minimum_payment_amount_cents: 3500,
    next_payment_due_date: '2026-08-25',
    purchase_apr_percentage: 18.24,
  };

  it('converts statement money and leaves purchase APR as a percentage', () => {
    const view = creditView(credit, accountRow({ id: 'acc_2', type: 'credit', name: 'Card' }));
    expect(view.last_statement_balance).toBe(800);
    expect(view.purchase_apr_percentage).toBe(18.24);
    expect(view.is_overdue).toBe(false);
    expect(view.account_name).toBe('Card');
    expect(view).not.toHaveProperty('last_statement_balance_cents');
  });

  it('treats unreported overdue as null, not false', () => {
    expect(creditView({ ...credit, is_overdue: null }, undefined).is_overdue).toBeNull();
  });

  it('converts APR money and leaves apr_percentage untouched', () => {
    const row: CreditAprRow = {
      account_id: 'acc_2',
      item_id: 'item_1',
      refreshed_at: 1000,
      apr_type: 'purchase_apr',
      apr_percentage: 6.125,
      balance_subject_to_apr_cents: 80_000,
      interest_charge_amount_cents: 1200,
    };
    const view = aprView(row);
    expect(view.apr_percentage).toBe(6.125);
    expect(view.balance_subject_to_apr).toBe(800);
    expect(view).not.toHaveProperty('balance_subject_to_apr_cents');
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
    [
      'liabilities',
      liabilitiesResultView({
        mortgages: [mortgageRow()],
        credit: [],
        aprs: [],
        accounts: [accountRow({ id: 'acc_loan', type: 'loan', current_balance_cents: 30_000_000 })],
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
