import { describe, expect, it } from 'vitest';
import {
  countTransactions,
  listAccountRows,
  openDb,
  upsertEnrollment,
  upsertTransactions,
} from '../src/core/db.js';
import { syncAll, toTransactionRow } from '../src/core/sync.js';
import { TellerApiError } from '../src/core/teller-client.js';
import type {
  TellerAccount,
  TellerApi,
  TellerBalance,
  TellerTransaction,
} from '../src/core/types.js';

function account(id: string): TellerAccount {
  return {
    id,
    enrollment_id: 'enr_1',
    name: `Account ${id}`,
    type: 'depository',
    subtype: 'checking',
    last_four: '1111',
    currency: 'USD',
    status: 'open',
    institution: { id: 'chase', name: 'Chase' },
  };
}

function wireTxn(id: string, over: Partial<TellerTransaction> = {}): TellerTransaction {
  return {
    id,
    account_id: 'acc_1',
    date: '2026-07-01',
    description: 'COFFEE',
    amount: '-4.50',
    status: 'posted',
    type: 'card_payment',
    running_balance: null,
    details: { processing_status: 'complete', category: 'dining', counterparty: { name: 'Blue Bottle' } },
    ...over,
  };
}

const balance: TellerBalance = { account_id: 'acc_1', available: '100.00', ledger: '100.00' };

/** Fake API: `pages` maps accountId -> array of pages returned in order per call. */
function fakeApi(overrides: Partial<TellerApi> & { pages?: Record<string, TellerTransaction[][]> }): TellerApi {
  const cursors: Record<string, number> = {};
  return {
    listAccounts: overrides.listAccounts ?? (async () => [account('acc_1')]),
    getBalance: overrides.getBalance ?? (async () => balance),
    listTransactions:
      overrides.listTransactions ??
      (async (_tok, accountId) => {
        const pages = overrides.pages?.[accountId] ?? [[]];
        const i = cursors[accountId] ?? 0;
        cursors[accountId] = i + 1;
        return pages[i] ?? [];
      }),
  };
}

function dbWithEnrollment() {
  const db = openDb(':memory:');
  upsertEnrollment(db, { id: 'enr_1', access_token: 'tok', institution: 'Chase', created_at: 1 });
  return db;
}

describe('toTransactionRow', () => {
  it('parses amount string and flattens counterparty', () => {
    const row = toTransactionRow(wireTxn('t1'));
    expect(row.amount).toBe(-4.5);
    expect(row.counterparty).toBe('Blue Bottle');
    expect(row.category).toBe('dining');
  });
});

describe('syncAll', () => {
  it('initial sync drains all pages backward', async () => {
    const db = dbWithEnrollment();
    const pageA = [wireTxn('t3'), wireTxn('t2')];
    const pageB = [wireTxn('t1')];
    const api = fakeApi({ pages: { acc_1: [pageA, pageB, []] } });
    const results = await syncAll(db, api, { now: () => 999 });
    expect(results[0]).toMatchObject({ ok: true, inserted: 3, updated: 0 });
    expect(countTransactions(db, 'acc_1')).toBe(3);
    expect(listAccountRows(db)[0]?.last_synced_at).toBe(999);
    expect(listAccountRows(db)[0]?.available_balance).toBe(100);
  });

  it('incremental sync stops when a page is fully known', async () => {
    const db = dbWithEnrollment();
    const api1 = fakeApi({ pages: { acc_1: [[wireTxn('t1', { status: 'pending' })], []] } });
    await syncAll(db, api1);
    let calls = 0;
    const api2 = fakeApi({
      listTransactions: async () => {
        calls += 1;
        return [wireTxn('t2'), wireTxn('t1', { status: 'posted' })];
      },
    });
    const results = await syncAll(db, api2);
    // page contained known id t1 -> upsert both, but t1 was known so page not "all new"; drain
    // continues only while pages contain unknown ids AND page was full; this page is short of
    // 1000 so sync stops after one call either way.
    expect(calls).toBe(1);
    expect(results[0]).toMatchObject({ ok: true, inserted: 1, updated: 1 });
  });

  it('isolates per-account failures', async () => {
    const db = dbWithEnrollment();
    const api = fakeApi({
      listAccounts: async () => [account('acc_1'), account('acc_2')],
      getBalance: async (_tok, id) => {
        if (id === 'acc_2') throw new Error('boom');
        return balance;
      },
      pages: { acc_1: [[wireTxn('t1')], []], acc_2: [[]] },
    });
    const results = await syncAll(db, api);
    expect(results).toHaveLength(2);
    expect(results.find(r => r.accountId === 'acc_1')?.ok).toBe(true);
    const failed = results.find(r => r.accountId === 'acc_2');
    expect(failed?.ok).toBe(false);
    expect(failed?.error).toContain('boom');
  });

  it('filters to a single account when opts.accountId given', async () => {
    const db = dbWithEnrollment();
    const api = fakeApi({
      listAccounts: async () => [account('acc_1'), account('acc_2')],
      pages: { acc_1: [[wireTxn('t1')], []], acc_2: [[wireTxn('t9', { account_id: 'acc_2' })], []] },
    });
    const results = await syncAll(db, api, { accountId: 'acc_2' });
    expect(results).toHaveLength(1);
    expect(results[0]?.accountId).toBe('acc_2');
  });

  it('flags needsReauth on a 401 and leaves it unset for other failures', async () => {
    const db = dbWithEnrollment();
    const api = fakeApi({
      listAccounts: async () => [account('acc_1'), account('acc_2')],
      getBalance: async (_tok, id) => {
        if (id === 'acc_1') throw new TellerApiError('unauthorized', 401);
        if (id === 'acc_2') throw new Error('boom');
        return balance;
      },
    });
    const results = await syncAll(db, api);
    const reauth = results.find(r => r.accountId === 'acc_1');
    expect(reauth).toMatchObject({ ok: false, needsReauth: true });
    const other = results.find(r => r.accountId === 'acc_2');
    expect(other).toMatchObject({ ok: false });
    expect(other?.needsReauth).toBeUndefined();
  });

  it('aborts a runaway pagination loop instead of hanging', async () => {
    const db = dbWithEnrollment();
    // Misbehaving API: ignores fromId and always returns the same non-empty page.
    // Initial sync (empty db) never hits the empty-page or fully-known exits, so
    // without a hard cap this would loop forever.
    const api = fakeApi({
      listTransactions: async () => [wireTxn('loop1'), wireTxn('loop2')],
    });
    const results = await syncAll(db, api, { maxPages: 5 });
    expect(results[0]).toMatchObject({ ok: false });
    expect(results[0]?.error).toContain('pagination exceeded');
  });
});
