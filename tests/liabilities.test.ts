import type {
  APR,
  AccountBase,
  CreditCardLiability,
  LiabilitiesGetResponse,
  MortgageLiability,
} from 'plaid';
import { describe, expect, it } from 'vitest';
import {
  getItem,
  listAccountRows,
  listCreditAprRows,
  listCreditRows,
  listMortgageRows,
  replaceLiabilities,
  type Db,
} from '../src/core/db.js';
import {
  listLiabilities,
  refreshLiabilities,
  toLiabilityRows,
} from '../src/core/liabilities.js';
import { PlaidApiError, type LedgerPlaidApi } from '../src/core/plaid-client.js';
import { NOW, addLoanAccount, seedDb } from './helpers.js';

function account(id: string, over: Partial<AccountBase> = {}): AccountBase {
  return {
    account_id: id,
    name: `Account ${id}`,
    official_name: null,
    mask: '9999',
    type: 'loan' as AccountBase['type'],
    subtype: 'mortgage' as AccountBase['subtype'],
    balances: {
      available: null,
      current: 300_000,
      limit: null,
      iso_currency_code: 'USD',
      unofficial_currency_code: null,
    },
    ...over,
  };
}

function apr(over: Partial<APR> = {}): APR {
  return {
    apr_percentage: 18.24,
    apr_type: 'purchase_apr' as APR['apr_type'],
    balance_subject_to_apr: 800,
    interest_charge_amount: 12,
    ...over,
  };
}

function creditCard(over: Partial<CreditCardLiability> = {}): CreditCardLiability {
  return {
    account_id: 'acc_2',
    aprs: [],
    is_overdue: false,
    last_payment_amount: 150,
    last_payment_date: '2026-08-05',
    last_statement_issue_date: '2026-08-01',
    last_statement_balance: 800,
    minimum_payment_amount: 35,
    next_payment_due_date: '2026-08-25',
    ...over,
  };
}

function mortgageLiab(over: Partial<MortgageLiability> = {}): MortgageLiability {
  return {
    account_id: 'acc_loan',
    account_number: 'SHOULD_NOT_STORE',
    current_late_fee: null,
    escrow_balance: 2500,
    has_pmi: false,
    has_prepayment_penalty: false,
    interest_rate: { percentage: 6.125, type: 'fixed' },
    last_payment_amount: 2100,
    last_payment_date: '2026-08-01',
    loan_type_description: 'conventional',
    loan_term: '30 year',
    maturity_date: '2054-05-01',
    next_monthly_payment: 2100,
    next_payment_due_date: '2026-09-01',
    origination_date: '2024-05-01',
    origination_principal_amount: 400_000,
    past_due_amount: null,
    property_address: {
      street: '1 Main St',
      city: 'Austin',
      region: 'TX',
      postal_code: '78701',
      country: 'US',
    },
    ytd_interest_paid: 8000,
    ytd_principal_paid: 4000,
    ...over,
  };
}

function response(over: Partial<LiabilitiesGetResponse> = {}): LiabilitiesGetResponse {
  return {
    accounts: [],
    item: { item_id: 'item_1' } as LiabilitiesGetResponse['item'],
    liabilities: { credit: null, mortgage: null, student: null },
    request_id: 'r',
    ...over,
  };
}

function fakeApi(over: Partial<LedgerPlaidApi> = {}): LedgerPlaidApi {
  const unused = () => {
    throw new Error('unexpected call');
  };
  return {
    getAccounts: unused as never,
    syncTransactions: unused as never,
    createLinkToken: unused as never,
    getLinkSession: unused as never,
    exchangePublicToken: unused as never,
    itemRemove: unused as never,
    getRecurringStreams: unused as never,
    getLiabilities: unused as never,
    refreshTransactions: unused as never,
    ...over,
  };
}

const KNOWN = new Set(['acc_1', 'acc_2', 'acc_loan']);

describe('toLiabilityRows', () => {
  it('converts money to cents and leaves 6.125 as a percentage', () => {
    const { snapshot, dropped } = toLiabilityRows(
      response({
        liabilities: { credit: null, mortgage: [mortgageLiab()], student: null },
      }),
      'item_1',
      NOW,
      KNOWN,
    );

    expect(dropped).toBe(0);
    const row = snapshot.mortgage[0];
    expect(row?.interest_rate_percentage).toBe(6.125);
    expect(row?.escrow_balance_cents).toBe(250_000);
    expect(row?.next_monthly_payment_cents).toBe(210_000);
    expect(row?.origination_principal_amount_cents).toBe(40_000_000);
    expect(row?.has_pmi).toBe(0);
    expect(row).not.toHaveProperty('account_number');
  });

  it('round-trips the all-null mortgage, including absent nested objects', () => {
    const thin = {
      account_id: 'acc_loan',
      account_number: null,
      current_late_fee: null,
      escrow_balance: null,
      has_pmi: null,
      has_prepayment_penalty: null,
      last_payment_amount: null,
      last_payment_date: null,
      loan_type_description: null,
      loan_term: null,
      maturity_date: null,
      next_monthly_payment: null,
      next_payment_due_date: null,
      origination_date: null,
      origination_principal_amount: null,
      past_due_amount: null,
      ytd_interest_paid: null,
      ytd_principal_paid: null,
    } as unknown as MortgageLiability;

    const { snapshot } = toLiabilityRows(
      response({ liabilities: { credit: null, mortgage: [thin], student: null } }),
      'item_1',
      NOW,
      KNOWN,
    );

    const row = snapshot.mortgage[0];
    expect(row?.interest_rate_percentage).toBeNull();
    expect(row?.interest_rate_type).toBeNull();
    expect(row?.property_city).toBeNull();
    expect(row?.has_pmi).toBeNull();
    expect(row?.escrow_balance_cents).toBeNull();
  });

  it('treats null and empty liability arrays as an empty snapshot', () => {
    const fromNull = toLiabilityRows(response(), 'item_1', NOW, KNOWN);
    const fromEmpty = toLiabilityRows(
      response({ liabilities: { credit: [], mortgage: [], student: [] } }),
      'item_1',
      NOW,
      KNOWN,
    );

    expect(fromNull.snapshot).toEqual({ mortgage: [], credit: [], aprs: [] });
    expect(fromEmpty.snapshot).toEqual({ mortgage: [], credit: [], aprs: [] });
    expect(fromNull.dropped).toBe(0);
    expect(fromEmpty.dropped).toBe(0);
  });

  it('denormalises purchase_apr and keeps every APR child, including two specials', () => {
    const { snapshot } = toLiabilityRows(
      response({
        liabilities: {
          mortgage: null,
          student: null,
          credit: [
            creditCard({
              aprs: [
                apr({ apr_type: 'purchase_apr' as APR['apr_type'], apr_percentage: 18.24 }),
                apr({ apr_type: 'cash_apr' as APR['apr_type'], apr_percentage: 24.99 }),
                apr({
                  apr_type: 'balance_transfer_apr' as APR['apr_type'],
                  apr_percentage: 0,
                }),
                apr({ apr_type: 'special' as APR['apr_type'], apr_percentage: 1.99 }),
                apr({ apr_type: 'special' as APR['apr_type'], apr_percentage: 0 }),
              ],
            }),
          ],
        },
      }),
      'item_1',
      NOW,
      KNOWN,
    );

    expect(snapshot.credit[0]?.purchase_apr_percentage).toBe(18.24);
    expect(snapshot.aprs).toHaveLength(5);
    expect(snapshot.aprs.filter(a => a.apr_type === 'special').map(a => a.apr_percentage)).toEqual(
      [1.99, 0],
    );
    expect(snapshot.aprs[0]?.apr_percentage).toBe(18.24);
    expect(snapshot.aprs[0]?.balance_subject_to_apr_cents).toBe(80_000);
  });

  it('drops a null or unknown account_id and counts it', () => {
    const { snapshot, dropped } = toLiabilityRows(
      response({
        liabilities: {
          student: null,
          mortgage: [mortgageLiab({ account_id: 'acc_gone' })],
          credit: [creditCard({ account_id: null })],
        },
      }),
      'item_1',
      NOW,
      KNOWN,
    );

    expect(dropped).toBe(2);
    expect(snapshot).toEqual({ mortgage: [], credit: [], aprs: [] });
  });
});

describe('refreshLiabilities', () => {
  it('upserts accounts first so a new loan is stored, not dropped', async () => {
    const db = seedDb();
    const api = fakeApi({
      getLiabilities: async () =>
        response({
          accounts: [account('acc_loan')],
          liabilities: { credit: null, mortgage: [mortgageLiab()], student: null },
        }),
    });

    const results = await refreshLiabilities(db, api, { now: () => NOW });

    expect(results).toEqual([
      {
        itemId: 'item_1',
        institution: 'Chase',
        ok: true,
        mortgages: 1,
        credit: 0,
        removed: 0,
        dropped: 0,
      },
    ]);
    expect(listMortgageRows(db)).toHaveLength(1);
    expect(listAccountRows(db).find(a => a.id === 'acc_loan')?.current_balance_cents).toBe(
      30_000_000,
    );
  });

  it('does not stamp last_synced_at from a liabilities read', async () => {
    const db = seedDb();
    const before = listAccountRows(db).find(a => a.id === 'acc_2')?.last_synced_at;
    const api = fakeApi({
      getLiabilities: async () =>
        response({
          accounts: [
            account('acc_2', {
              type: 'credit' as AccountBase['type'],
              subtype: 'credit card' as AccountBase['subtype'],
              balances: {
                available: 1000,
                current: 200,
                limit: 5000,
                iso_currency_code: 'USD',
                unofficial_currency_code: null,
              },
            }),
          ],
          liabilities: { credit: [creditCard()], mortgage: null, student: null },
        }),
    });

    await refreshLiabilities(db, api, { now: () => NOW });

    const card = listAccountRows(db).find(a => a.id === 'acc_2');
    expect(card?.last_synced_at).toBe(before);
    expect(card?.limit_cents).toBe(500_000);
  });

  it('treats NO_LIABILITY_ACCOUNTS as success and writes the empty snapshot', async () => {
    const db = seedDb();
    replaceLiabilities(
      db,
      'item_1',
      {
        mortgage: [],
        credit: [
          {
            account_id: 'acc_2',
            item_id: 'item_1',
            refreshed_at: 1,
            is_overdue: 0,
            last_payment_amount_cents: 1,
            last_payment_date: null,
            last_statement_issue_date: null,
            last_statement_balance_cents: null,
            minimum_payment_amount_cents: null,
            next_payment_due_date: null,
            purchase_apr_percentage: null,
          },
        ],
        aprs: [],
      },
      1,
    );
    const api = fakeApi({
      getLiabilities: async () => {
        throw new PlaidApiError('none', 'NO_LIABILITY_ACCOUNTS', 'INVALID_REQUEST', 400);
      },
    });

    const results = await refreshLiabilities(db, api, { now: () => NOW });

    expect(results[0]).toMatchObject({
      ok: true,
      noLiabilityAccounts: true,
      mortgages: 0,
      credit: 0,
      dropped: 0,
    });
    expect(results[0]?.removed).toBe(1);
    expect(listCreditRows(db)).toEqual([]);
    expect(getItem(db, 'item_1')?.liabilities_refreshed_at).toBe(NOW);
  });

  it('names ledger auth consent on ADDITIONAL_CONSENT_REQUIRED and leaves rows', async () => {
    const db = seedDb();
    addLoanAccount(db, 'acc_loan');
    const stored = toLiabilityRows(
      response({
        liabilities: { credit: null, mortgage: [mortgageLiab()], student: null },
      }),
      'item_1',
      NOW,
      KNOWN,
    ).snapshot;
    replaceLiabilities(db, 'item_1', stored, NOW);
    const api = fakeApi({
      getLiabilities: async () => {
        throw new PlaidApiError('nope', 'ADDITIONAL_CONSENT_REQUIRED', 'INVALID_INPUT', 400);
      },
    });

    const results = await refreshLiabilities(db, api, { now: () => NOW });

    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.needsConsent).toBe(true);
    expect(results[0]?.unsupported).toBeUndefined();
    expect(results[0]?.error).toMatch(/ledger auth consent/);
    expect(listMortgageRows(db)).toHaveLength(1);
  });

  it('marks PRODUCTS_NOT_SUPPORTED as unsupported and does not suggest consent', async () => {
    const db = seedDb();
    const api = fakeApi({
      getLiabilities: async () => {
        throw new PlaidApiError('nope', 'PRODUCTS_NOT_SUPPORTED', 'INVALID_INPUT', 400);
      },
    });

    const results = await refreshLiabilities(db, api, { now: () => NOW });

    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.unsupported).toBe(true);
    expect(results[0]?.needsConsent).toBeUndefined();
    expect(results[0]?.error).not.toMatch(/ledger auth consent/);
  });

  it('reports a reauth failure distinctly', async () => {
    const db = seedDb();
    const api = fakeApi({
      getLiabilities: async () => {
        throw new PlaidApiError('nope', 'ITEM_LOGIN_REQUIRED', 'ITEM_ERROR', 400);
      },
    });

    const results = await refreshLiabilities(db, api, { now: () => NOW });

    expect(results[0]?.needsReauth).toBe(true);
    expect(results[0]?.needsConsent).toBeUndefined();
    expect(results[0]?.unsupported).toBeUndefined();
  });
});

describe('listLiabilities', () => {
  function seedBoth(db: Db): void {
    addLoanAccount(db, 'acc_loan');
    const { snapshot } = toLiabilityRows(
      response({
        liabilities: {
          student: null,
          mortgage: [mortgageLiab()],
          credit: [creditCard({ aprs: [apr()] })],
        },
      }),
      'item_1',
      NOW,
      KNOWN,
    );
    replaceLiabilities(db, 'item_1', snapshot, NOW);
  }

  it('returns mortgages, credit, and aprs together', () => {
    const db = seedDb();
    seedBoth(db);

    const result = listLiabilities(db, {}, () => NOW);
    expect(result.mortgages).toHaveLength(1);
    expect(result.credit).toHaveLength(1);
    expect(result.aprs).toHaveLength(1);
    expect(result.accounts.map(a => a.id).sort()).toEqual(['acc_2', 'acc_loan']);
  });

  it('filters by kind and by account', () => {
    const db = seedDb();
    seedBoth(db);

    expect(listLiabilities(db, { kind: 'mortgage' }, () => NOW).credit).toEqual([]);
    expect(listLiabilities(db, { kind: 'mortgage' }, () => NOW).aprs).toEqual([]);
    expect(listLiabilities(db, { kind: 'credit' }, () => NOW).mortgages).toEqual([]);
    expect(listLiabilities(db, { accountId: 'acc_2' }, () => NOW).mortgages).toEqual([]);
    expect(listLiabilities(db, { accountId: 'acc_2' }, () => NOW).credit).toHaveLength(1);
  });

  it('reports a refreshed empty snapshot as fresh, not permanently stale', () => {
    const db = seedDb();
    replaceLiabilities(db, 'item_1', { mortgage: [], credit: [], aprs: [] }, NOW);

    const fresh = listLiabilities(db, {}, () => NOW);
    const stale = listLiabilities(db, {}, () => NOW + 25 * 3600 * 1000);

    expect(fresh.mortgages).toEqual([]);
    expect(fresh.meta).toEqual({ last_synced_at: NOW, stale: false });
    expect(stale.meta.stale).toBe(true);
  });

  it('reports stale with a null timestamp when nothing has been refreshed', () => {
    const db = seedDb();
    expect(listLiabilities(db, {}, () => NOW).meta).toEqual({ last_synced_at: null, stale: true });
  });
});
