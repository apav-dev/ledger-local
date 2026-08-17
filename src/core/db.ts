import fs from 'node:fs';
import Database from 'better-sqlite3';

export type Db = Database.Database;

export interface ItemRow {
  id: string;
  access_token: string;
  institution: string;
  institution_id: string | null;
  /** `/transactions/sync` cursor. NULL means no sync has completed yet. */
  cursor: string | null;
  created_at: number;
}

export type ItemUpsert = Omit<ItemRow, 'cursor'>;

export interface AccountRow {
  id: string;
  item_id: string;
  name: string;
  official_name: string | null;
  institution: string;
  type: string;
  subtype: string | null;
  /** Plaid returns null when the institution does not expose a mask. */
  mask: string | null;
  /** Null when the account reports an unofficial currency (e.g. crypto). */
  iso_currency_code: string | null;
  available_balance: number | null;
  current_balance: number | null;
  last_synced_at: number | null;
}

export type AccountUpsert = Omit<AccountRow, 'last_synced_at'>;

export interface TransactionRow {
  id: string;
  account_id: string;
  date: string;
  description: string;
  /**
   * Plaid-native sign: POSITIVE is money leaving the account, NEGATIVE is money
   * arriving. This is the inverse of a bank statement. Every spend predicate in
   * queries.ts depends on it.
   */
  amount: number;
  category_primary: string | null;
  category_detailed: string | null;
  counterparty: string | null;
  /** Derived from Plaid's `pending` boolean: 'pending' | 'posted'. */
  status: string;
  type: string;
  /**
   * Set on a posted transaction that replaced a pending one. Plaid assigns the
   * posted row a NEW id and returns the pending id under `removed`.
   */
  pending_transaction_id: string | null;
}

/** One page of `/transactions/sync` output. */
export interface SyncPage {
  added: TransactionRow[];
  modified: TransactionRow[];
  removedIds: string[];
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS items (
  id              TEXT PRIMARY KEY,
  access_token    TEXT NOT NULL,
  institution     TEXT NOT NULL,
  institution_id  TEXT,
  cursor          TEXT,
  created_at      INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS accounts (
  id                 TEXT PRIMARY KEY,
  item_id            TEXT NOT NULL REFERENCES items(id),
  name               TEXT NOT NULL,
  official_name      TEXT,
  institution        TEXT NOT NULL,
  type               TEXT NOT NULL,
  subtype            TEXT,
  mask               TEXT,
  iso_currency_code  TEXT,
  available_balance  REAL,
  current_balance    REAL,
  last_synced_at     INTEGER
);
CREATE TABLE IF NOT EXISTS transactions (
  id                     TEXT PRIMARY KEY,
  account_id             TEXT NOT NULL REFERENCES accounts(id),
  date                   TEXT NOT NULL,
  description            TEXT NOT NULL,
  amount                 REAL NOT NULL,
  category_primary       TEXT,
  category_detailed      TEXT,
  counterparty           TEXT,
  status                 TEXT NOT NULL,
  type                   TEXT NOT NULL,
  pending_transaction_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_txn_account_date ON transactions(account_id, date);
CREATE INDEX IF NOT EXISTS idx_txn_date ON transactions(date);
CREATE INDEX IF NOT EXISTS idx_txn_category ON transactions(category_primary);
CREATE INDEX IF NOT EXISTS idx_acct_item ON accounts(item_id);
`;

export function openDb(dbPath: string): Db {
  const fresh = dbPath !== ':memory:' && !fs.existsSync(dbPath);
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  if (fresh) fs.chmodSync(dbPath, 0o600);
  if (dbPath !== ':memory:') {
    // WAL and shm carry the same row data as the main file, so they need the
    // same restriction. They may not exist yet on a fresh open.
    for (const suffix of ['-wal', '-shm']) {
      const sidecar = `${dbPath}${suffix}`;
      if (fs.existsSync(sidecar)) fs.chmodSync(sidecar, 0o600);
    }
  }
  return db;
}

// ---------------------------------------------------------------- items

/**
 * Upserting an Item deliberately leaves `cursor` alone. Re-linking the same
 * Item through update mode must not discard sync progress, or the next sync
 * re-downloads all history.
 */
export function upsertItem(db: Db, row: ItemUpsert): void {
  db.prepare(
    `INSERT INTO items (id, access_token, institution, institution_id, cursor, created_at)
     VALUES (@id, @access_token, @institution, @institution_id, NULL, @created_at)
     ON CONFLICT(id) DO UPDATE SET
       access_token   = excluded.access_token,
       institution    = excluded.institution,
       institution_id = excluded.institution_id`,
  ).run(row);
}

export function listItems(db: Db): ItemRow[] {
  return db.prepare('SELECT * FROM items ORDER BY created_at').all() as ItemRow[];
}

export function getItem(db: Db, itemId: string): ItemRow | undefined {
  return db.prepare('SELECT * FROM items WHERE id = ?').get(itemId) as ItemRow | undefined;
}

export function setItemCursor(db: Db, itemId: string, cursor: string): void {
  db.prepare('UPDATE items SET cursor = ? WHERE id = ?').run(cursor, itemId);
}

/** Resolves an account to its owning Item, since Plaid syncs per Item. */
export function itemIdForAccount(db: Db, accountId: string): string | undefined {
  const row = db.prepare('SELECT item_id FROM accounts WHERE id = ?').get(accountId) as
    | { item_id: string }
    | undefined;
  return row?.item_id;
}

// ------------------------------------------------------------- accounts

export function upsertAccount(db: Db, row: AccountUpsert): void {
  db.prepare(
    `INSERT INTO accounts (
       id, item_id, name, official_name, institution, type, subtype, mask,
       iso_currency_code, available_balance, current_balance, last_synced_at
     ) VALUES (
       @id, @item_id, @name, @official_name, @institution, @type, @subtype, @mask,
       @iso_currency_code, @available_balance, @current_balance, NULL
     )
     ON CONFLICT(id) DO UPDATE SET
       item_id           = excluded.item_id,
       name              = excluded.name,
       official_name     = excluded.official_name,
       institution       = excluded.institution,
       type              = excluded.type,
       subtype           = excluded.subtype,
       mask              = excluded.mask,
       iso_currency_code = excluded.iso_currency_code,
       available_balance = excluded.available_balance,
       current_balance   = excluded.current_balance`,
  ).run(row);
}

export function setAccountSynced(db: Db, accountId: string, ts: number): void {
  db.prepare('UPDATE accounts SET last_synced_at = ? WHERE id = ?').run(ts, accountId);
}

export function listAccountRows(db: Db): AccountRow[] {
  return db.prepare('SELECT * FROM accounts ORDER BY institution, name').all() as AccountRow[];
}

export function listAccountIdsForItem(db: Db, itemId: string): string[] {
  const rows = db.prepare('SELECT id FROM accounts WHERE item_id = ?').all(itemId) as Array<{
    id: string;
  }>;
  return rows.map(r => r.id);
}

// --------------------------------------------------------- transactions

/**
 * SQLite caps a statement at SQLITE_MAX_VARIABLE_NUMBER bound parameters
 * (32766 on modern builds). Plaid pages max out at 500 transactions, but
 * chunking keeps callers safe if that ever changes.
 */
const MAX_BOUND_PARAMS = 900;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function knownTransactionIds(db: Db, ids: string[]): Set<string> {
  const found = new Set<string>();
  for (const batch of chunk(ids, MAX_BOUND_PARAMS)) {
    const placeholders = batch.map(() => '?').join(',');
    const rows = db
      .prepare(`SELECT id FROM transactions WHERE id IN (${placeholders})`)
      .all(...batch) as Array<{ id: string }>;
    for (const r of rows) found.add(r.id);
  }
  return found;
}

export function countTransactions(db: Db, accountId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM transactions WHERE account_id = ?')
    .get(accountId) as { n: number };
  return row.n;
}

export function upsertTransactions(
  db: Db,
  rows: TransactionRow[],
): { inserted: number; updated: number } {
  if (rows.length === 0) return { inserted: 0, updated: 0 };
  const known = knownTransactionIds(
    db,
    rows.map(r => r.id),
  );
  const stmt = db.prepare(
    `INSERT INTO transactions (
       id, account_id, date, description, amount, category_primary, category_detailed,
       counterparty, status, type, pending_transaction_id
     ) VALUES (
       @id, @account_id, @date, @description, @amount, @category_primary, @category_detailed,
       @counterparty, @status, @type, @pending_transaction_id
     )
     ON CONFLICT(id) DO UPDATE SET
       date                   = excluded.date,
       description            = excluded.description,
       amount                 = excluded.amount,
       category_primary       = excluded.category_primary,
       category_detailed      = excluded.category_detailed,
       counterparty           = excluded.counterparty,
       status                 = excluded.status,
       type                   = excluded.type,
       pending_transaction_id = excluded.pending_transaction_id`,
  );
  for (const row of rows) stmt.run(row);
  const updated = rows.filter(r => known.has(r.id)).length;
  return { inserted: rows.length - updated, updated };
}

/**
 * Required for correctness, not an optimization. When a pending transaction
 * posts, Plaid issues a NEW transaction_id and returns the pending id under
 * `removed`. Skipping the delete double-counts that spend permanently.
 *
 * Returns the number of rows actually deleted, which can be lower than
 * ids.length when Plaid reports a removal for a transaction we never stored.
 */
export function deleteTransactions(db: Db, ids: string[]): number {
  let deleted = 0;
  for (const batch of chunk(ids, MAX_BOUND_PARAMS)) {
    const placeholders = batch.map(() => '?').join(',');
    const info = db
      .prepare(`DELETE FROM transactions WHERE id IN (${placeholders})`)
      .run(...batch);
    deleted += info.changes;
  }
  return deleted;
}

export interface ApplyPageResult {
  inserted: number;
  updated: number;
  removed: number;
}

/**
 * Applies one sync page and advances the cursor atomically. Cursor and rows must
 * commit together: a cursor saved without its rows silently loses transactions
 * forever, since Plaid will never resend them.
 *
 * Any transaction referencing an unknown account violates the foreign key and
 * aborts the whole page rather than being dropped. That is deliberate — an
 * orphan means accounts and transactions disagree, which should be loud.
 */
export function applySyncPage(
  db: Db,
  itemId: string,
  page: SyncPage,
  cursor: string,
): ApplyPageResult {
  const run = db.transaction((): ApplyPageResult => {
    const addedCounts = upsertTransactions(db, page.added);
    const modifiedCounts = upsertTransactions(db, page.modified);
    const removed = deleteTransactions(db, page.removedIds);
    setItemCursor(db, itemId, cursor);
    return {
      inserted: addedCounts.inserted + modifiedCounts.inserted,
      updated: addedCounts.updated + modifiedCounts.updated,
      removed,
    };
  });
  return run();
}
