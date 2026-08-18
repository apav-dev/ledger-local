import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applySyncPage,
  countTransactions,
  deleteTransactions,
  getItem,
  itemConsent,
  itemIdForAccount,
  knownTransactionIds,
  listAccountIdsForItem,
  listAccountRows,
  listItems,
  openDb,
  readMeta,
  setAccountSynced,
  setItemConsent,
  setItemCursor,
  upsertAccount,
  upsertItem,
  upsertTransactions,
  type AccountUpsert,
  type Db,
  type ItemUpsert,
  type TransactionRow,
} from '../src/core/db.js';
import { fullTransactionRow } from './helpers.js';

function tmpDbPath(name: string): string {
  return join(mkdtempSync(join(tmpdir(), 'ledger-test-')), `${name}.db`);
}

const item: ItemUpsert = {
  id: 'item_1',
  access_token: 'access-sandbox-abc',
  institution: 'Chase',
  institution_id: 'ins_56',
  created_at: 1_700_000_000_000,
  consented_products: null,
};

const account: AccountUpsert = {
  id: 'acc_1',
  item_id: 'item_1',
  name: 'Total Checking',
  official_name: 'Chase Total Checking',
  institution: 'Chase',
  type: 'depository',
  subtype: 'checking',
  mask: '4821',
  iso_currency_code: 'USD',
  available_balance_cents: 120_050, // $1,200.50
  current_balance_cents: 125_000, // $1,250.00
};

/**
 * Amounts are integer cents. Plaid-native sign: positive means money left the
 * account.
 */
function txn(id: string, over: Partial<TransactionRow> = {}): TransactionRow {
  return {
    id,
    account_id: 'acc_1',
    date: '2026-07-01',
    description: 'COSTCO WHSE',
    amount_cents: 5213, // $52.13
    category_primary: 'GENERAL_MERCHANDISE',
    category_detailed: 'GENERAL_MERCHANDISE_SUPERSTORES',
    counterparty: 'Costco',
    status: 'posted',
    payment_channel: 'in store',
    authorized_date: null, authorized_datetime: null, datetime: null,
    original_description: null,
    iso_currency_code: 'USD', unofficial_currency_code: null,
    category_confidence: null, category_icon_url: null,
    merchant_entity_id: null,
    website: null, logo_url: null,
    counterparty_type: null, counterparties_json: null,
    transaction_code: null, check_number: null, account_owner: null,
    location_address: null, location_city: null, location_region: null,
    location_postal_code: null, location_country: null,
    location_lat: null, location_lon: null, location_store_number: null,
    payment_meta_reference_number: null, payment_meta_ppd_id: null,
    payment_meta_payee: null, payment_meta_by_order_of: null,
    payment_meta_payer: null, payment_meta_payment_method: null,
    payment_meta_payment_processor: null, payment_meta_reason: null,
    pending_transaction_id: null,
    ...over,
  };
}

function freshDb() {
  const db = openDb(':memory:', 'sandbox');
  upsertItem(db, item);
  upsertAccount(db, account);
  return db;
}

let tmpDbDir: string | undefined;

afterEach(() => {
  if (tmpDbDir !== undefined) {
    rmSync(tmpDbDir, { recursive: true, force: true });
    tmpDbDir = undefined;
  }
});

describe('items', () => {
  it('round-trips items and updates on conflict', () => {
    const db = freshDb();
    upsertItem(db, { ...item, access_token: 'access-sandbox-new' });
    const rows = listItems(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.access_token).toBe('access-sandbox-new');
    expect(rows[0]?.institution_id).toBe('ins_56');
  });

  it('starts a new item with a NULL cursor so the first sync is a full backfill', () => {
    const db = freshDb();
    expect(getItem(db, 'item_1')?.cursor).toBeNull();
  });

  it('preserves the cursor across re-upsert', () => {
    // Update-mode re-link must not reset sync progress, or the next sync
    // re-downloads all history.
    const db = freshDb();
    setItemCursor(db, 'item_1', 'cursor_abc');
    upsertItem(db, { ...item, access_token: 'access-sandbox-rotated' });
    expect(getItem(db, 'item_1')?.cursor).toBe('cursor_abc');
  });

  it('resolves an account to its owning item', () => {
    const db = freshDb();
    expect(itemIdForAccount(db, 'acc_1')).toBe('item_1');
    expect(itemIdForAccount(db, 'acc_missing')).toBeUndefined();
  });

  it('lists account ids for an item', () => {
    const db = freshDb();
    upsertAccount(db, { ...account, id: 'acc_2', name: 'Savings' });
    expect(listAccountIdsForItem(db, 'item_1').sort()).toEqual(['acc_1', 'acc_2']);
    expect(listAccountIdsForItem(db, 'item_absent')).toEqual([]);
  });
});

describe('accounts', () => {
  it('preserves last_synced_at across re-upsert', () => {
    const db = freshDb();
    setAccountSynced(db, 'acc_1', 123456);
    upsertAccount(db, { ...account, available_balance_cents: 90_000 });
    const rows = listAccountRows(db);
    expect(rows[0]?.available_balance_cents).toBe(90_000);
    expect(rows[0]?.last_synced_at).toBe(123456);
  });

  it('accepts null mask and null currency, which Plaid does return', () => {
    const db = freshDb();
    upsertAccount(db, { ...account, id: 'acc_3', mask: null, iso_currency_code: null });
    const row = listAccountRows(db).find(a => a.id === 'acc_3');
    expect(row?.mask).toBeNull();
    expect(row?.iso_currency_code).toBeNull();
  });
});

describe('transactions', () => {
  it('reports inserted vs updated and updates in place', () => {
    const db = freshDb();
    const first = upsertTransactions(db, [txn('t1', { status: 'pending' }), txn('t2')]);
    expect(first).toEqual({ inserted: 2, updated: 0 });
    const second = upsertTransactions(db, [txn('t1', { status: 'posted', amount_cents: 5500 })]);
    expect(second).toEqual({ inserted: 0, updated: 1 });
    expect(countTransactions(db, 'acc_1')).toBe(2);
    const row = db
      .prepare('SELECT status, amount_cents FROM transactions WHERE id = ?')
      .get('t1') as { status: string; amount_cents: number };
    expect(row.status).toBe('posted');
    expect(row.amount_cents).toBe(5500);
  });

  it('stores amounts as integers, not floats', () => {
    // Guards the whole point of the cents representation: if a float ever
    // reaches the column, SQLite's dynamic typing would happily store it.
    const db = freshDb();
    upsertTransactions(db, [txn('t1', { amount_cents: 5213 })]);
    const row = db
      .prepare("SELECT typeof(amount_cents) AS t FROM transactions WHERE id = 't1'")
      .get() as { t: string };
    expect(row.t).toBe('integer');
  });

  it('knownTransactionIds returns only existing ids', () => {
    const db = freshDb();
    upsertTransactions(db, [txn('t1')]);
    const known = knownTransactionIds(db, ['t1', 't2']);
    expect(known.has('t1')).toBe(true);
    expect(known.has('t2')).toBe(false);
  });

  it('handles an empty id list without issuing a query', () => {
    const db = freshDb();
    expect(knownTransactionIds(db, []).size).toBe(0);
    expect(deleteTransactions(db, [])).toBe(0);
    expect(upsertTransactions(db, [])).toEqual({ inserted: 0, updated: 0 });
  });

  it('chunks past the SQLite bound-parameter cap', () => {
    // 2000 ids exceeds a single statement's practical parameter budget; a
    // non-chunked IN(...) would throw here.
    const db = freshDb();
    const rows = Array.from({ length: 2000 }, (_, i) => txn(`bulk_${i}`));
    expect(upsertTransactions(db, rows).inserted).toBe(2000);
    const ids = rows.map(r => r.id);
    expect(knownTransactionIds(db, ids).size).toBe(2000);
    expect(deleteTransactions(db, ids)).toBe(2000);
  });

  it('deleteTransactions ignores ids it never stored', () => {
    const db = freshDb();
    upsertTransactions(db, [txn('t1')]);
    expect(deleteTransactions(db, ['t1', 'never_stored'])).toBe(1);
    expect(countTransactions(db, 'acc_1')).toBe(0);
  });

  it('rejects a transaction for an unknown account instead of dropping it', () => {
    const db = freshDb();
    expect(() => upsertTransactions(db, [txn('t1', { account_id: 'acc_ghost' })])).toThrow(
      /FOREIGN KEY/i,
    );
  });
});

describe('applySyncPage', () => {
  it('applies added, modified, and removed then advances the cursor', () => {
    const db = freshDb();
    upsertTransactions(db, [txn('old_pending', { status: 'pending' })]);

    const result = applySyncPage(
      db,
      'item_1',
      {
        added: [txn('posted_new', { pending_transaction_id: 'old_pending' })],
        modified: [txn('old_pending', { status: 'pending', amount_cents: 6000 })],
        removedIds: ['old_pending'],
      },
      'cursor_1',
    );

    // The modified row is written and then removed within the same page; the
    // removal is what Plaid intends to win.
    expect(result.removed).toBe(1);
    expect(getItem(db, 'item_1')?.cursor).toBe('cursor_1');
    expect(countTransactions(db, 'acc_1')).toBe(1);
    const ids = db.prepare('SELECT id FROM transactions').all() as Array<{ id: string }>;
    expect(ids.map(r => r.id)).toEqual(['posted_new']);
  });

  it('resolves the pending-to-posted handoff without double counting', () => {
    // The single most important correctness case: Plaid gives the posted
    // transaction a NEW id and returns the pending id under `removed`.
    const db = freshDb();
    applySyncPage(
      db,
      'item_1',
      {
        added: [txn('pend_1', { status: 'pending', amount_cents: 2300 })],
        modified: [],
        removedIds: [],
      },
      'cursor_1',
    );
    expect(countTransactions(db, 'acc_1')).toBe(1);

    applySyncPage(
      db,
      'item_1',
      {
        added: [txn('post_1', { amount_cents: 2350, pending_transaction_id: 'pend_1' })],
        modified: [],
        removedIds: ['pend_1'],
      },
      'cursor_2',
    );

    expect(countTransactions(db, 'acc_1')).toBe(1);
    const total = db.prepare('SELECT SUM(amount_cents) AS s FROM transactions').get() as {
      s: number;
    };
    expect(total.s).toBe(2350);
  });

  it('leaves the cursor untouched when the page fails to apply', () => {
    // Cursor and rows must commit together. A cursor saved without its rows
    // loses those transactions permanently, since Plaid never resends them.
    const db = freshDb();
    setItemCursor(db, 'item_1', 'cursor_safe');
    expect(() =>
      applySyncPage(
        db,
        'item_1',
        { added: [txn('orphan', { account_id: 'acc_ghost' })], modified: [], removedIds: [] },
        'cursor_advanced',
      ),
    ).toThrow(/FOREIGN KEY/i);
    expect(getItem(db, 'item_1')?.cursor).toBe('cursor_safe');
    expect(countTransactions(db, 'acc_1')).toBe(0);
  });
});

describe('openDb', () => {
  it('chmods the db file and WAL sidecar to 0600', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-db-test-'));
    tmpDbDir = dir;
    const dbPath = join(dir, 'test.db');
    const db = openDb(dbPath, 'sandbox');
    upsertItem(db, item);
    upsertAccount(db, account);

    expect(statSync(dbPath).mode & 0o777).toBe(0o600);
    const walPath = `${dbPath}-wal`;
    if (existsSync(walPath)) {
      expect(statSync(walPath).mode & 0o777).toBe(0o600);
    }
  });

  it('enforces foreign keys', () => {
    const db = openDb(':memory:', 'sandbox');
    expect(() => upsertAccount(db, account)).toThrow(/FOREIGN KEY/i);
  });

  it('stamps a schema version on a fresh database', () => {
    const db = openDb(':memory:', 'sandbox');
    expect(db.pragma('user_version', { simple: true })).toBe(4);
  });

  it('reopens its own database without complaint', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-db-test-'));
    tmpDbDir = dir;
    const dbPath = join(dir, 'test.db');
    openDb(dbPath, 'sandbox').close();
    expect(() => openDb(dbPath, 'sandbox').close()).not.toThrow();
  });

  it('refuses a pre-versioning database instead of silently mismatching columns', () => {
    // CREATE TABLE IF NOT EXISTS no-ops against an existing table, so an old
    // file would keep its REAL dollar columns and fail later on insert with a
    // confusing missing-column error. Fail here, with instructions, instead.
    const dir = mkdtempSync(join(tmpdir(), 'ledger-db-test-'));
    tmpDbDir = dir;
    const dbPath = join(dir, 'legacy.db');
    const legacy = new Database(dbPath);
    legacy.exec('CREATE TABLE transactions (id TEXT PRIMARY KEY, amount REAL)');
    legacy.close(); // user_version stays 0

    expect(() => openDb(dbPath, 'sandbox')).toThrow(/older build with an incompatible schema/);
  });

  it('refuses a database written by a newer build', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-db-test-'));
    tmpDbDir = dir;
    const dbPath = join(dir, 'future.db');
    const future = new Database(dbPath);
    future.pragma('user_version = 99');
    future.close();

    expect(() => openDb(dbPath, 'sandbox')).toThrow(/schema version 99/);
    expect(() => openDb(dbPath, 'sandbox')).toThrow(/upgrade/);
  });

  it('tells an older-schema user to delete, not to upgrade', () => {
    // v1 is BEHIND this build, so the "a newer version wrote this" advice would
    // be backwards. Direct these users to delete the file instead.
    const dir = mkdtempSync(join(tmpdir(), 'ledger-db-test-'));
    tmpDbDir = dir;
    const dbPath = join(dir, 'v1.db');
    const old = new Database(dbPath);
    old.pragma('user_version = 1');
    old.close();

    expect(() => openDb(dbPath, 'sandbox')).toThrow(/schema version 1/);
    expect(() => openDb(dbPath, 'sandbox')).toThrow(/[Dd]elete/);
  });
});

describe('openDb environment stamping', () => {
  it('records the environment on a fresh database', () => {
    const db = openDb(':memory:', 'production');
    expect(readMeta(db, 'environment')).toBe('production');
  });

  it('reopens cleanly when the environment matches', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-db-test-'));
    tmpDbDir = dir;
    const dbPath = join(dir, 'env.db');
    openDb(dbPath, 'sandbox').close();
    expect(() => openDb(dbPath, 'sandbox').close()).not.toThrow();
  });

  it('refuses to open a sandbox database against production', () => {
    // The access tokens in a sandbox db are meaningless to the production host.
    // Without this guard every Plaid call fails with a confusing auth error.
    const dir = mkdtempSync(join(tmpdir(), 'ledger-db-test-'));
    tmpDbDir = dir;
    const dbPath = join(dir, 'mismatch.db');
    openDb(dbPath, 'sandbox').close();

    expect(() => openDb(dbPath, 'production')).toThrow(/sandbox/);
    expect(() => openDb(dbPath, 'production')).toThrow(/production/);
    expect(() => openDb(dbPath, 'production')).toThrow(/LEDGER_DATA_DIR/);
  });

  it('refuses the reverse mismatch too', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-db-test-'));
    tmpDbDir = dir;
    const dbPath = join(dir, 'mismatch2.db');
    openDb(dbPath, 'production').close();

    expect(() => openDb(dbPath, 'sandbox')).toThrow(/environment/);
  });

  it('never leaks an access token into the mismatch message', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-db-test-'));
    tmpDbDir = dir;
    const dbPath = join(dir, 'tokens.db');
    const db = openDb(dbPath, 'sandbox');
    upsertItem(db, item);
    db.close();

    try {
      openDb(dbPath, 'production');
      expect.unreachable('openDb should have thrown on environment mismatch');
    } catch (error) {
      expect((error as Error).message).not.toContain(item.access_token);
    }
  });
});

describe('schema v3', () => {
  // NOT seedDb(): that fixture inserts transactions, and Task 4 is what widens
  // them. Task 1 must stand alone, so it builds the minimum a transaction needs
  // — one item, one account for the foreign key — and nothing else.
  function dbWithAccount(): Db {
    const db = openDb(':memory:', 'sandbox');
    upsertItem(db, {
      id: 'item_1', access_token: 'tok', institution: 'Chase',
      institution_id: 'ins_56', created_at: 1, consented_products: null,
    });
    upsertAccount(db, {
      id: 'acc_1', item_id: 'item_1', name: 'Checking', official_name: null,
      institution: 'Chase', type: 'depository', subtype: 'checking', mask: '1111',
      iso_currency_code: 'USD', available_balance_cents: 0, current_balance_cents: 0,
    });
    return db;
  }

  it('round-trips every column a TransactionRow declares', () => {
    const db = dbWithAccount();
    const row = fullTransactionRow({ id: 't_full' });

    upsertTransactions(db, [row]);

    const read = db.prepare('SELECT * FROM transactions WHERE id = ?').get('t_full');
    // Equality against the whole row, not field-by-field: a column present in
    // the type but missing from the INSERT would otherwise pass unnoticed.
    expect(read).toEqual(row);
  });

  it('updates every column on conflict', () => {
    const db = dbWithAccount();
    upsertTransactions(db, [fullTransactionRow({ id: 't_up' })]);

    // Every mutable column changes value. A column left out of the ON CONFLICT
    // list keeps its old value and fails this comparison.
    const changed: TransactionRow = Object.fromEntries(
      Object.entries(fullTransactionRow({ id: 't_up' })).map(([k, v]) => {
        if (k === 'id' || k === 'account_id') return [k, v];
        if (typeof v === 'number') return [k, v + 1];
        return [k, `${String(v)}-changed`];
      }),
    ) as TransactionRow;
    upsertTransactions(db, [changed]);

    expect(db.prepare('SELECT * FROM transactions WHERE id = ?').get('t_up')).toEqual(changed);
  });

  it('has no `type` column — payment_channel replaced it', () => {
    const db = dbWithAccount();

    const columns = (db.pragma('table_info(transactions)') as Array<{ name: string }>)
      .map(c => c.name);

    expect(columns).toContain('payment_channel');
    expect(columns).not.toContain('type');
  });

  it('rejects a database written by an older build, naming the real cost', () => {
    const dbPath = tmpDbPath('stale');
    const raw = new Database(dbPath);
    raw.exec('CREATE TABLE items (id TEXT PRIMARY KEY)');
    raw.pragma('user_version = 2');
    raw.close();

    // The old message claimed "No data is lost by deleting it", which is false
    // once an access token is in there and contradicts the README.
    expect(() => openDb(dbPath, 'sandbox')).toThrow(/re-link/i);
    expect(() => openDb(dbPath, 'sandbox')).not.toThrow(/No data is lost/i);
  });
});

describe('item consent', () => {
  it('round-trips a consent list', () => {
    const db = openDb(':memory:', 'sandbox');
    upsertItem(db, {
      id: 'item_1', access_token: 'tok', institution: 'Chase',
      institution_id: 'ins_56', created_at: 1, consented_products: null,
    });

    setItemConsent(db, 'item_1', ['liabilities', 'investments']);

    expect(itemConsent(db, 'item_1')).toEqual(['liabilities', 'investments']);
  });

  it('reports an empty list when consent was never recorded', () => {
    const db = openDb(':memory:', 'sandbox');
    upsertItem(db, {
      id: 'item_1', access_token: 'tok', institution: 'Chase',
      institution_id: 'ins_56', created_at: 1, consented_products: null,
    });

    expect(itemConsent(db, 'item_1')).toEqual([]);
  });

  it('does not reset consent when an item is re-upserted by update mode', () => {
    const db = openDb(':memory:', 'sandbox');
    const row = {
      id: 'item_1', access_token: 'tok', institution: 'Chase',
      institution_id: 'ins_56', created_at: 1, consented_products: null,
    };
    upsertItem(db, row);
    setItemConsent(db, 'item_1', ['liabilities']);

    upsertItem(db, { ...row, access_token: 'tok2' });

    expect(itemConsent(db, 'item_1')).toEqual(['liabilities']);
  });

  it('stamps a fresh database at version 4', () => {
    const db = openDb(':memory:', 'sandbox');

    expect(db.pragma('user_version', { simple: true })).toBe(4);
  });
});
