import { describe, expect, it } from 'vitest';
import {
  countTransactions,
  knownTransactionIds,
  listAccountRows,
  listEnrollments,
  openDb,
  setAccountSynced,
  upsertAccount,
  upsertEnrollment,
  upsertTransactions,
  type AccountUpsert,
  type TransactionRow,
} from '../src/core/db.js';

const enrollment = {
  id: 'enr_1',
  access_token: 'token_abc',
  institution: 'Chase',
  created_at: 1_700_000_000_000,
};

const account: AccountUpsert = {
  id: 'acc_1',
  enrollment_id: 'enr_1',
  name: 'Total Checking',
  institution: 'Chase',
  type: 'depository',
  subtype: 'checking',
  last_four: '4821',
  currency: 'USD',
  status: 'open',
  available_balance: 1200.5,
  ledger_balance: 1250.0,
};

function txn(id: string, over: Partial<TransactionRow> = {}): TransactionRow {
  return {
    id,
    account_id: 'acc_1',
    date: '2026-07-01',
    description: 'COSTCO WHSE',
    amount: -52.13,
    category: 'groceries',
    counterparty: 'Costco',
    status: 'posted',
    type: 'card_payment',
    running_balance: null,
    ...over,
  };
}

function freshDb() {
  const db = openDb(':memory:');
  upsertEnrollment(db, enrollment);
  upsertAccount(db, account);
  return db;
}

describe('db', () => {
  it('round-trips enrollments and updates on conflict', () => {
    const db = freshDb();
    upsertEnrollment(db, { ...enrollment, access_token: 'token_new' });
    const rows = listEnrollments(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.access_token).toBe('token_new');
  });

  it('upsertAccount preserves last_synced_at across re-upsert', () => {
    const db = freshDb();
    setAccountSynced(db, 'acc_1', 123456);
    upsertAccount(db, { ...account, available_balance: 900 });
    const rows = listAccountRows(db);
    expect(rows[0]?.available_balance).toBe(900);
    expect(rows[0]?.last_synced_at).toBe(123456);
  });

  it('upsertTransactions reports inserted vs updated and updates in place', () => {
    const db = freshDb();
    const first = upsertTransactions(db, [txn('t1', { status: 'pending' }), txn('t2')]);
    expect(first).toEqual({ inserted: 2, updated: 0 });
    const second = upsertTransactions(db, [txn('t1', { status: 'posted', amount: -55.0 })]);
    expect(second).toEqual({ inserted: 0, updated: 1 });
    expect(countTransactions(db, 'acc_1')).toBe(2);
  });

  it('knownTransactionIds returns only existing ids', () => {
    const db = freshDb();
    upsertTransactions(db, [txn('t1')]);
    const known = knownTransactionIds(db, ['t1', 't2']);
    expect(known.has('t1')).toBe(true);
    expect(known.has('t2')).toBe(false);
  });
});
