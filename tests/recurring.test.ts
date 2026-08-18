import type { TransactionStream, TransactionsRecurringGetResponse } from 'plaid';
import { describe, expect, it } from 'vitest';
import { listRecurringStreamRows, replaceRecurringStreams, type Db } from '../src/core/db.js';
import { PlaidApiError, type LedgerPlaidApi } from '../src/core/plaid-client.js';
import { listRecurring, refreshRecurring, toRecurringRows } from '../src/core/recurring.js';
import { NOW, seedDb } from './helpers.js';

function stream(id: string, over: Partial<TransactionStream> = {}): TransactionStream {
  return {
    account_id: 'acc_1',
    stream_id: id,
    category: null,
    category_id: null,
    description: 'NETFLIX',
    merchant_name: 'Netflix',
    first_date: '2026-01-15',
    last_date: '2026-08-15',
    predicted_next_date: '2026-09-15',
    frequency: 'MONTHLY' as TransactionStream['frequency'],
    transaction_ids: ['t1', 't2', 't3'],
    average_amount: { amount: 15.99, iso_currency_code: 'USD', unofficial_currency_code: null },
    last_amount: { amount: 15.99, iso_currency_code: 'USD', unofficial_currency_code: null },
    is_active: true,
    status: 'MATURE' as TransactionStream['status'],
    personal_finance_category: {
      primary: 'ENTERTAINMENT',
      detailed: 'ENTERTAINMENT_STREAMING',
    },
    is_user_modified: false,
    ...over,
  };
}

function response(over: Partial<TransactionsRecurringGetResponse> = {}): TransactionsRecurringGetResponse {
  return {
    inflow_streams: [],
    outflow_streams: [],
    updated_datetime: '2026-08-18T00:00:00Z',
    request_id: 'r',
    ...over,
  } as TransactionsRecurringGetResponse;
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
    refreshTransactions: unused as never,
    ...over,
  };
}

describe('toRecurringRows', () => {
  it('tags direction and converts dollars to cents', () => {
    const rows = toRecurringRows(
      response({ outflow_streams: [stream('s_out')], inflow_streams: [stream('s_in')] }),
      'item_1',
      NOW,
    );

    expect(rows).toHaveLength(2);
    expect(rows.find(r => r.stream_id === 's_out')?.direction).toBe('outflow');
    expect(rows.find(r => r.stream_id === 's_in')?.direction).toBe('inflow');
    expect(rows[0]?.average_amount_cents).toBe(1599);
    expect(rows[0]?.transaction_count).toBe(3);
    expect(rows[0]?.refreshed_at).toBe(NOW);
  });

  it('tolerates a stream with no amount and no predicted date', () => {
    const rows = toRecurringRows(
      response({
        outflow_streams: [
          stream('s_sparse', {
            average_amount: { iso_currency_code: 'USD', unofficial_currency_code: null },
            last_amount: { iso_currency_code: 'USD', unofficial_currency_code: null },
            predicted_next_date: null,
          }),
        ],
      }),
      'item_1',
      NOW,
    );

    expect(rows[0]?.average_amount_cents).toBeNull();
    expect(rows[0]?.last_amount_cents).toBeNull();
    expect(rows[0]?.predicted_next_date).toBeNull();
  });

  it('stores is_active as 0 or 1', () => {
    const rows = toRecurringRows(
      response({
        outflow_streams: [stream('s_dead', { is_active: false, status: 'TOMBSTONED' as never })],
      }),
      'item_1',
      NOW,
    );

    expect(rows[0]?.is_active).toBe(0);
    expect(rows[0]?.status).toBe('TOMBSTONED');
  });
});

describe('refreshRecurring', () => {
  it('stores streams and reports the count', async () => {
    const db = seedDb();
    const api = fakeApi({
      getRecurringStreams: async () => response({ outflow_streams: [stream('s1'), stream('s2')] }),
    });

    const results = await refreshRecurring(db, api, { now: () => NOW });

    expect(results).toEqual([
      { itemId: 'item_1', institution: 'Chase', ok: true, streams: 2, removed: 0 },
    ]);
    expect(listRecurringStreamRows(db)).toHaveLength(2);
  });

  it('reports a consent failure with an actionable flag and leaves stored streams alone', async () => {
    const db = seedDb();
    replaceRecurringStreams(
      db,
      'item_1',
      toRecurringRows(response({ outflow_streams: [stream('s_old')] }), 'item_1', NOW),
    );
    const api = fakeApi({
      getRecurringStreams: async () => {
        throw new PlaidApiError('nope', 'ADDITIONAL_CONSENT_REQUIRED', 'INVALID_INPUT', 400);
      },
    });

    const results = await refreshRecurring(db, api, { now: () => NOW });

    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.needsConsent).toBe(true);
    // Mentions consent only to preempt it — that command cannot grant this product.
    expect(results[0]?.error).toMatch(/Dashboard > Developers > Products/);
    expect(results[0]?.error).toMatch(/not something `ledger auth consent` can grant/);
    // A failed refresh must not wipe the previous snapshot.
    expect(listRecurringStreamRows(db)).toHaveLength(1);
  });

  it('reports a reauth failure distinctly from a consent failure', async () => {
    const db = seedDb();
    const api = fakeApi({
      getRecurringStreams: async () => {
        throw new PlaidApiError('nope', 'ITEM_LOGIN_REQUIRED', 'ITEM_ERROR', 400);
      },
    });

    const results = await refreshRecurring(db, api, { now: () => NOW });

    expect(results[0]?.needsReauth).toBe(true);
    expect(results[0]?.needsConsent).toBeUndefined();
  });

  it('drops streams for accounts that no longer exist rather than aborting', async () => {
    const db = seedDb();
    const api = fakeApi({
      getRecurringStreams: async () =>
        response({ outflow_streams: [stream('s_ghost', { account_id: 'acc_gone' })] }),
    });

    const results = await refreshRecurring(db, api, { now: () => NOW });

    expect(results[0]?.ok).toBe(true);
    expect(results[0]?.streams).toBe(0);
    expect(listRecurringStreamRows(db)).toEqual([]);
  });
});

describe('listRecurring', () => {
  function seedStreams(db: Db): void {
    replaceRecurringStreams(
      db,
      'item_1',
      toRecurringRows(
        response({
          outflow_streams: [
            stream('s_netflix'),
            stream('s_dead', { is_active: false, status: 'TOMBSTONED' as never }),
            stream('s_weekly', { frequency: 'WEEKLY' as never }),
          ],
          inflow_streams: [stream('s_pay', { description: 'PAYROLL' })],
        }),
        'item_1',
        NOW,
      ),
    );
  }

  it('returns everything by default', () => {
    const db = seedDb();
    seedStreams(db);

    expect(listRecurring(db, {}, () => NOW).streams).toHaveLength(4);
  });

  it('filters to active streams', () => {
    const db = seedDb();
    seedStreams(db);

    const ids = listRecurring(db, { activeOnly: true }, () => NOW).streams.map(s => s.stream_id);

    expect(ids).not.toContain('s_dead');
    expect(ids).toHaveLength(3);
  });

  it('filters by direction and by frequency, case-insensitively', () => {
    const db = seedDb();
    seedStreams(db);

    expect(listRecurring(db, { direction: 'inflow' }, () => NOW).streams.map(s => s.stream_id)).toEqual([
      's_pay',
    ]);
    expect(listRecurring(db, { frequency: 'weekly' }, () => NOW).streams.map(s => s.stream_id)).toEqual([
      's_weekly',
    ]);
  });

  it('reports staleness from the refresh time, not the transaction sync time', () => {
    const db = seedDb();
    seedStreams(db);

    const fresh = listRecurring(db, {}, () => NOW);
    const stale = listRecurring(db, {}, () => NOW + 25 * 3600 * 1000);

    expect(fresh.meta.stale).toBe(false);
    expect(stale.meta.stale).toBe(true);
  });

  it('reports stale with a null timestamp when nothing has been refreshed', () => {
    const db = seedDb();

    expect(listRecurring(db, {}, () => NOW).meta).toEqual({ last_synced_at: null, stale: true });
  });
});
