import type { AccountBase, Transaction, TransactionsSyncResponse } from 'plaid';
import { describe, expect, it } from 'vitest';
import {
  countTransactions,
  getItem,
  listAccountRows,
  openDb,
  setItemCursor,
  upsertItem,
  type Db,
} from '../src/core/db.js';
import { PlaidApiError, type LedgerPlaidApi } from '../src/core/plaid-client.js';
import { syncAll, toAccountUpsert, toTransactionRow } from '../src/core/sync.js';

function account(id: string, over: Partial<AccountBase> = {}): AccountBase {
  return {
    account_id: id,
    name: `Account ${id}`,
    official_name: `Official ${id}`,
    mask: '1111',
    type: 'depository' as AccountBase['type'],
    subtype: 'checking' as AccountBase['subtype'],
    balances: {
      available: 100,
      current: 120,
      limit: null,
      iso_currency_code: 'USD',
      unofficial_currency_code: null,
    },
    ...over,
  };
}

/** Plaid-native amounts: positive means money left the account. */
function txn(id: string, over: Partial<Transaction> = {}): Transaction {
  return {
    transaction_id: id,
    account_id: 'acc_1',
    date: '2026-07-01',
    name: 'COFFEE',
    amount: 4.5,
    pending: false,
    pending_transaction_id: null,
    payment_channel: 'in store',
    merchant_name: 'Blue Bottle',
    personal_finance_category: { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_COFFEE' },
    iso_currency_code: 'USD',
    ...over,
  } as Transaction;
}

function page(over: Partial<TransactionsSyncResponse> = {}): TransactionsSyncResponse {
  return {
    accounts: [],
    added: [],
    modified: [],
    removed: [],
    next_cursor: 'cursor_end',
    has_more: false,
    ...over,
  } as TransactionsSyncResponse;
}

/** `pages` are returned in order, one per syncTransactions call. */
function fakeApi(
  overrides: Partial<LedgerPlaidApi> & { pages?: TransactionsSyncResponse[] } = {},
): LedgerPlaidApi {
  let i = 0;
  return {
    itemRemove: overrides.itemRemove ?? (async () => {}),
    getAccounts: overrides.getAccounts ?? (async () => [account('acc_1')]),
    syncTransactions:
      overrides.syncTransactions ??
      (async () => {
        const pages = overrides.pages ?? [page()];
        const next = pages[i] ?? page();
        i += 1;
        return next;
      }),
    createLinkToken: overrides.createLinkToken ?? (async () => ({ linkToken: 'l', hostedLinkUrl: null })),
    getLinkSession: overrides.getLinkSession ?? (async () => ({}) as never),
    exchangePublicToken:
      overrides.exchangePublicToken ?? (async () => ({ accessToken: 'a', itemId: 'i' })),
    getRecurringStreams:
      overrides.getRecurringStreams ??
      (async () => {
        throw new Error('unexpected call');
      }),
    refreshTransactions:
      overrides.refreshTransactions ??
      (async () => {
        throw new Error('unexpected call');
      }),
  };
}

function dbWithItem(): Db {
  const db = openDb(':memory:', 'sandbox');
  upsertItem(db, {
    id: 'item_1',
    access_token: 'access-sandbox-tok',
    institution: 'Chase',
    institution_id: 'ins_56',
    created_at: 1,
    consented_products: null,
  });
  return db;
}

describe('toTransactionRow', () => {
  it('maps Plaid fields and preserves the native sign', () => {
    const row = toTransactionRow(txn('t1'));
    // Plaid sends 4.5 decimal dollars; storage is 450 cents, still positive
    // because positive is an outflow. The sign is NOT negated.
    expect(row.amount_cents).toBe(450);
    expect(row.description).toBe('COFFEE');
    expect(row.counterparty).toBe('Blue Bottle');
    expect(row.category_primary).toBe('FOOD_AND_DRINK');
    expect(row.category_detailed).toBe('FOOD_AND_DRINK_COFFEE');
    expect(row.status).toBe('posted');
    expect(row.payment_channel).toBe('in store');
  });

  it('keeps inflows negative', () => {
    expect(toTransactionRow(txn('t1', { amount: -2000 })).amount_cents).toBe(-200_000);
  });

  it('converts amounts that a naive float multiply would round down', () => {
    // 12.34 * 100 is 1233.9999999999998 in IEEE 754. Truncating would lose a
    // cent on a large share of real transactions.
    expect(toTransactionRow(txn('t1', { amount: 12.34 })).amount_cents).toBe(1234);
    expect(toTransactionRow(txn('t1', { amount: 129.95 })).amount_cents).toBe(12_995);
  });

  it('derives status from the pending boolean', () => {
    expect(toTransactionRow(txn('t1', { pending: true })).status).toBe('pending');
  });

  it('tolerates missing category and merchant', () => {
    const row = toTransactionRow(
      txn('t1', { personal_finance_category: null, merchant_name: null } as Partial<Transaction>),
    );
    expect(row.category_primary).toBeNull();
    expect(row.category_detailed).toBeNull();
    expect(row.counterparty).toBeNull();
  });
});

describe('toTransactionRow field mapping', () => {
  it('carries the enrichment fields Plaid sends', () => {
    const row = toTransactionRow(
      txn('t_rich', {
        authorized_date: '2026-07-30',
        original_description: 'SQ *BLUE BOTTLE 4411',
        merchant_entity_id: 'ent_bluebottle',
        transaction_code: 'purchase' as Transaction['transaction_code'],
        personal_finance_category: {
          primary: 'FOOD_AND_DRINK',
          detailed: 'FOOD_AND_DRINK_COFFEE',
          confidence_level: 'VERY_HIGH',
        },
        location: {
          address: null, city: 'Oakland', region: 'CA', postal_code: null,
          country: 'US', lat: null, lon: null, store_number: null,
        } as Transaction['location'],
      }),
    );

    expect(row.authorized_date).toBe('2026-07-30');
    expect(row.original_description).toBe('SQ *BLUE BOTTLE 4411');
    expect(row.merchant_entity_id).toBe('ent_bluebottle');
    expect(row.transaction_code).toBe('purchase');
    expect(row.category_confidence).toBe('VERY_HIGH');
    expect(row.location_city).toBe('Oakland');
    expect(row.location_region).toBe('CA');
    expect(row.payment_channel).toBe('in store');
    expect(row.iso_currency_code).toBe('USD');
  });

  it('nulls every optional field when Plaid omits it', () => {
    const row = toTransactionRow(
      txn('t_bare', {
        merchant_name: null,
        personal_finance_category: null,
        iso_currency_code: null,
        unofficial_currency_code: null,
      }),
    );

    expect(row.authorized_date).toBeNull();
    expect(row.original_description).toBeNull();
    expect(row.merchant_entity_id).toBeNull();
    expect(row.transaction_code).toBeNull();
    expect(row.category_confidence).toBeNull();
    expect(row.counterparty).toBeNull();
    expect(row.counterparty_type).toBeNull();
    expect(row.iso_currency_code).toBeNull();
  });

  it('falls back to the primary counterparty when merchant_name is absent, and records its type', () => {
    const row = toTransactionRow(
      txn('t_venmo', {
        merchant_name: null,
        counterparties: [
          {
            name: 'Venmo',
            type: 'payment_app' as never,
            entity_id: 'ent_venmo',
            website: null,
            logo_url: null,
            confidence_level: 'HIGH',
          },
        ] as NonNullable<Transaction['counterparties']>,
      }),
    );

    expect(row.counterparty).toBe('Venmo');
    expect(row.counterparty_type).toBe('payment_app');
  });

  it('keeps the two currency codes separate rather than coalescing them', () => {
    const row = toTransactionRow(
      txn('t_crypto', { iso_currency_code: null, unofficial_currency_code: 'BTC' }),
    );

    expect(row.iso_currency_code).toBeNull();
    expect(row.unofficial_currency_code).toBe('BTC');
  });

  it('flattens location and payment_meta into their own columns', () => {
    const row = toTransactionRow(
      txn('t_ach', {
        location: {
          address: '300 Webster St', city: 'Oakland', region: 'CA',
          postal_code: '94607', country: 'US', lat: 37.8, lon: -122.27,
          store_number: '4411',
        } as Transaction['location'],
        payment_meta: {
          reference_number: 'REF1', ppd_id: 'PPD1', payee: 'Landlord',
          by_order_of: null, payer: null, payment_method: 'ACH',
          payment_processor: null, reason: 'RENT',
        } as Transaction['payment_meta'],
        check_number: '1234',
        account_owner: 'AARON PAVLICK',
      }),
    );

    expect(row.location_address).toBe('300 Webster St');
    expect(row.location_postal_code).toBe('94607');
    expect(row.location_lat).toBe(37.8);
    expect(row.location_lon).toBe(-122.27);
    expect(row.location_store_number).toBe('4411');
    expect(row.payment_meta_reference_number).toBe('REF1');
    expect(row.payment_meta_payee).toBe('Landlord');
    expect(row.payment_meta_payment_method).toBe('ACH');
    expect(row.payment_meta_reason).toBe('RENT');
    expect(row.payment_meta_by_order_of).toBeNull();
    expect(row.check_number).toBe('1234');
    expect(row.account_owner).toBe('AARON PAVLICK');
  });

  it('stores the whole counterparties array as JSON, and NULL when absent', () => {
    const withArray = toTransactionRow(
      txn('t_cp', {
        counterparties: [
          { name: 'Venmo', type: 'payment_app' as never, entity_id: 'ent_v',
            website: null, logo_url: null, confidence_level: 'HIGH' },
          { name: 'Corner Store', type: 'merchant' as never, entity_id: 'ent_c',
            website: null, logo_url: null, confidence_level: 'MEDIUM' },
        ] as NonNullable<Transaction['counterparties']>,
      }),
    );
    const without = toTransactionRow(txn('t_nocp', {}));

    // The full chain survives even though only the primary is denormalised.
    expect(JSON.parse(withArray.counterparties_json ?? '[]')).toHaveLength(2);
    expect(withArray.counterparty_type).toBe('payment_app');
    // NULL, not "[]" — "Plaid sent nothing" and "Plaid sent an empty list" differ.
    expect(without.counterparties_json).toBeNull();
  });

  it('survives a payload missing location and payment_meta entirely', () => {
    const row = toTransactionRow(
      txn('t_sparse', {
        location: undefined as never,
        payment_meta: undefined as never,
      }),
    );

    expect(row.location_city).toBeNull();
    expect(row.payment_meta_payee).toBeNull();
  });
});

describe('toAccountUpsert', () => {
  it('maps balances and passes the institution through', () => {
    const row = toAccountUpsert(account('acc_1'), 'item_1', 'Chase');
    expect(row).toMatchObject({
      id: 'acc_1',
      item_id: 'item_1',
      institution: 'Chase',
      available_balance_cents: 10_000,
      current_balance_cents: 12_000,
      iso_currency_code: 'USD',
    });
  });

  it('falls back to the unofficial currency code', () => {
    const row = toAccountUpsert(
      account('acc_1', {
        balances: {
          available: 1,
          current: 1,
          limit: null,
          iso_currency_code: null,
          unofficial_currency_code: 'BTC',
        },
      }),
      'item_1',
      'Chase',
    );
    expect(row.iso_currency_code).toBe('BTC');
  });

  it('accepts a null mask', () => {
    expect(toAccountUpsert(account('acc_1', { mask: null }), 'item_1', 'Chase').mask).toBeNull();
  });
});

describe('syncAll', () => {
  it('drains pages forward and persists the final cursor', async () => {
    const db = dbWithItem();
    const api = fakeApi({
      pages: [
        page({ added: [txn('t1'), txn('t2')], next_cursor: 'c1', has_more: true }),
        page({ added: [txn('t3')], next_cursor: 'c2', has_more: false }),
      ],
    });
    const results = await syncAll(db, api, { now: () => 999 });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ ok: true, inserted: 3, updated: 0, removed: 0 });
    expect(countTransactions(db, 'acc_1')).toBe(3);
    expect(getItem(db, 'item_1')?.cursor).toBe('c2');
    expect(listAccountRows(db)[0]?.last_synced_at).toBe(999);
    expect(listAccountRows(db)[0]?.available_balance_cents).toBe(10_000);
  });

  it('sends the stored cursor so a second sync is incremental', async () => {
    const db = dbWithItem();
    setItemCursor(db, 'item_1', 'stored_cursor');
    const seen: Array<string | null> = [];
    const api = fakeApi({
      syncTransactions: async (_tok, cursor) => {
        seen.push(cursor);
        return page();
      },
    });
    await syncAll(db, api);
    expect(seen).toEqual(['stored_cursor']);
  });

  it('passes a null cursor on a first-ever sync', async () => {
    const db = dbWithItem();
    const seen: Array<string | null> = [];
    const api = fakeApi({
      syncTransactions: async (_tok, cursor) => {
        seen.push(cursor);
        return page();
      },
    });
    await syncAll(db, api);
    expect(seen).toEqual([null]);
  });

  it('applies removals and reports them per account', async () => {
    const db = dbWithItem();
    const first = fakeApi({ pages: [page({ added: [txn('pend_1', { pending: true })] })] });
    await syncAll(db, first);
    expect(countTransactions(db, 'acc_1')).toBe(1);

    const second = fakeApi({
      pages: [
        page({
          added: [txn('post_1', { amount: 5.0, pending_transaction_id: 'pend_1' })],
          removed: [{ transaction_id: 'pend_1', account_id: 'acc_1' }],
        }),
      ],
    });
    const results = await syncAll(db, second);

    // The pending row must be gone, not merely superseded.
    expect(countTransactions(db, 'acc_1')).toBe(1);
    expect(results[0]).toMatchObject({ inserted: 1, removed: 1 });
    const total = db.prepare('SELECT SUM(amount_cents) AS s FROM transactions').get() as {
      s: number;
    };
    expect(total.s).toBe(500);
  });

  it('attributes counts to the right account within one Item', async () => {
    const db = dbWithItem();
    const api = fakeApi({
      getAccounts: async () => [account('acc_1'), account('acc_2')],
      pages: [
        page({
          added: [txn('t1'), txn('t2', { account_id: 'acc_2' })],
          removed: [{ transaction_id: 'gone', account_id: 'acc_2' }],
        }),
      ],
    });
    const results = await syncAll(db, api);

    expect(results.find(r => r.accountId === 'acc_1')).toMatchObject({ inserted: 1, removed: 0 });
    expect(results.find(r => r.accountId === 'acc_2')).toMatchObject({ inserted: 1, removed: 1 });
  });

  it('reports accounts with no changes as ok with zero counts', async () => {
    const db = dbWithItem();
    const results = await syncAll(db, fakeApi({ pages: [page()] }));
    expect(results[0]).toMatchObject({ accountId: 'acc_1', ok: true, inserted: 0, updated: 0 });
  });

  it('upserts an account that only appears in the sync response', async () => {
    // Guards the foreign key: an account opened between balance/get and sync
    // would otherwise have transactions with no parent row.
    const db = dbWithItem();
    const api = fakeApi({
      getAccounts: async () => [account('acc_1')],
      pages: [page({ accounts: [account('acc_new')], added: [txn('t1', { account_id: 'acc_new' })] })],
    });
    const results = await syncAll(db, api);

    expect(results.some(r => !r.ok)).toBe(false);
    expect(listAccountRows(db).map(a => a.id).sort()).toEqual(['acc_1', 'acc_new']);
    expect(countTransactions(db, 'acc_new')).toBe(1);
  });

  it('isolates a failing Item from a healthy one', async () => {
    const db = dbWithItem();
    upsertItem(db, {
      id: 'item_2',
      access_token: 'access-sandbox-broken',
      institution: 'Amex',
      institution_id: 'ins_10',
      created_at: 2,
      consented_products: null,
    });
    const api = fakeApi({
      getAccounts: async token => {
        if (token === 'access-sandbox-broken') throw new Error('boom');
        return [account('acc_1')];
      },
      pages: [page({ added: [txn('t1')] })],
    });
    const results = await syncAll(db, api);

    expect(results.find(r => r.accountId === 'acc_1')?.ok).toBe(true);
    const failed = results.find(r => r.accountId === 'item:item_2');
    expect(failed).toMatchObject({ ok: false, accountName: 'Amex' });
    expect(failed?.error).toContain('boom');
    expect(failed?.needsReauth).toBeUndefined();
  });

  it('flags needsReauth from ITEM_LOGIN_REQUIRED, which arrives as HTTP 400', async () => {
    const db = dbWithItem();
    const api = fakeApi({
      getAccounts: async () => {
        throw new PlaidApiError('login required', 'ITEM_LOGIN_REQUIRED', 'ITEM_ERROR', 400);
      },
    });
    const results = await syncAll(db, api);
    expect(results[0]).toMatchObject({ ok: false, needsReauth: true });
  });

  it('does not flag needsReauth for an unrelated 400', async () => {
    const db = dbWithItem();
    const api = fakeApi({
      getAccounts: async () => {
        throw new PlaidApiError('bad field', 'INVALID_FIELD', 'INVALID_REQUEST', 400);
      },
    });
    const results = await syncAll(db, api);
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.needsReauth).toBeUndefined();
  });

  it('aborts when Plaid reports has_more without advancing the cursor', async () => {
    const db = dbWithItem();
    const api = fakeApi({
      syncTransactions: async () => page({ next_cursor: 'stuck', has_more: true }),
    });
    setItemCursor(db, 'item_1', 'stuck');
    const results = await syncAll(db, api);
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.error).toContain('unchanged cursor');
  });

  it('aborts a runaway pagination loop instead of hanging', async () => {
    const db = dbWithItem();
    let n = 0;
    const api = fakeApi({
      syncTransactions: async () => {
        n += 1;
        return page({ next_cursor: `c${n}`, has_more: true });
      },
    });
    const results = await syncAll(db, api, { maxPages: 5 });
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.error).toContain('pagination exceeded');
  });

  it('filters to one Item when itemId is given', async () => {
    const db = dbWithItem();
    upsertItem(db, {
      id: 'item_2',
      access_token: 'tok2',
      institution: 'Amex',
      institution_id: 'ins_10',
      created_at: 2,
      consented_products: null,
    });
    const api = fakeApi({
      getAccounts: async token => [account(token === 'tok2' ? 'acc_2' : 'acc_1')],
    });
    const results = await syncAll(db, api, { itemId: 'item_2' });
    expect(results).toHaveLength(1);
    expect(results[0]?.accountId).toBe('acc_2');
  });

  it('reports only the requested account but never hides an Item failure', async () => {
    const db = dbWithItem();
    const api = fakeApi({
      getAccounts: async () => [account('acc_1'), account('acc_2')],
      pages: [page({ added: [txn('t1'), txn('t2', { account_id: 'acc_2' })] })],
    });
    const results = await syncAll(db, api, { accountId: 'acc_2' });
    expect(results).toHaveLength(1);
    expect(results[0]?.accountId).toBe('acc_2');

    const broken = fakeApi({
      getAccounts: async () => {
        throw new Error('item down');
      },
    });
    const failures = await syncAll(db, broken, { accountId: 'acc_2' });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ ok: false, accountId: 'item:item_1' });
  });

  it('returns nothing when no items are linked', async () => {
    expect(await syncAll(openDb(':memory:', 'sandbox'), fakeApi())).toEqual([]);
  });
});

describe('sync --force', () => {
  it('does not refresh unless asked', async () => {
    const db = dbWithItem();
    let refreshes = 0;
    const api = fakeApi({
      refreshTransactions: async () => {
        refreshes += 1;
      },
      syncTransactions: async () => page({ added: [txn('t1')] }),
    });

    await syncAll(db, api);

    expect(refreshes).toBe(0);
  });

  it('refreshes once per item before syncing it', async () => {
    const db = dbWithItem();
    const order: string[] = [];
    const api = fakeApi({
      refreshTransactions: async () => {
        order.push('refresh');
      },
      getAccounts: async () => {
        order.push('accounts');
        return [account('acc_1')];
      },
      syncTransactions: async () => {
        order.push('sync');
        return page({ added: [txn('t1')] });
      },
    });

    await syncAll(db, api, { force: true });

    // Refresh must precede the sync, or the pull it triggers cannot be picked up.
    expect(order[0]).toBe('refresh');
    expect(order.filter(o => o === 'refresh')).toHaveLength(1);
  });

  it('marks results as refreshed so the caller can report it', async () => {
    const db = dbWithItem();
    const api = fakeApi({
      refreshTransactions: async () => {},
      syncTransactions: async () => page({ added: [txn('t1')] }),
    });

    const results = await syncAll(db, api, { force: true });

    expect(results.every(r => r.refreshed === true)).toBe(true);
  });

  it('reports a failed refresh as a failed item instead of syncing stale data silently', async () => {
    const db = dbWithItem();
    const api = fakeApi({
      refreshTransactions: async () => {
        throw new PlaidApiError('nope', 'ITEM_LOGIN_REQUIRED', 'ITEM_ERROR', 400);
      },
      syncTransactions: async () => page({ added: [txn('t1')] }),
    });

    const results = await syncAll(db, api, { force: true });

    expect(results.every(r => r.ok)).toBe(false);
    expect(results.some(r => r.needsReauth === true)).toBe(true);
  });

  it('omits the refreshed flag entirely on a normal sync', async () => {
    const db = dbWithItem();
    const api = fakeApi({ syncTransactions: async () => page({ added: [txn('t1')] }) });

    const results = await syncAll(db, api);

    expect(results[0]?.refreshed).toBeUndefined();
  });
});
