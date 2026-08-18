import fs from 'node:fs';
import Database from 'better-sqlite3';
import type { PlaidEnvironment } from './config.js';

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
  /** Integer cents. Null when the institution does not report the balance. */
  available_balance_cents: number | null;
  /** Integer cents. Null when the institution does not report the balance. */
  current_balance_cents: number | null;
  last_synced_at: number | null;
}

export type AccountUpsert = Omit<AccountRow, 'last_synced_at'>;

export interface TransactionRow {
  id: string;
  account_id: string;
  date: string;
  description: string;
  /**
   * Integer cents, never decimal dollars — 4599 means $45.99. Converted from
   * Plaid's decimal dollars at ingest and back to dollars only at the output
   * boundary in views.ts.
   *
   * Plaid-native sign: POSITIVE is money leaving the account, NEGATIVE is money
   * arriving. This is the inverse of a bank statement. Every spend predicate in
   * queries.ts depends on it.
   */
  amount_cents: number;
  category_primary: string | null;
  category_detailed: string | null;
  counterparty: string | null;
  /** Derived from Plaid's `pending` boolean: 'pending' | 'posted'. */
  status: string;
  /**
   * Set on a posted transaction that replaced a pending one. Plaid assigns the
   * posted row a NEW id and returns the pending id under `removed`.
   */
  pending_transaction_id: string | null;
  /** Purchase date when the institution reports it. `date` is the POST date. */
  authorized_date: string | null;
  /** ISO 8601. Rare — most US institutions report dates only. */
  authorized_datetime: string | null;
  /** ISO 8601 post timestamp. Rare, same reason. */
  datetime: string | null;
  /** Raw bank memo before Plaid's cleanup. Searched alongside `description`. */
  original_description: string | null;
  /** Plaid populates exactly one of these two. Both stored, neither coalesced. */
  iso_currency_code: string | null;
  /** Set instead of `iso_currency_code` for crypto and unofficial currencies. */
  unofficial_currency_code: string | null;
  /** VERY_HIGH | HIGH | MEDIUM | LOW | UNKNOWN. Null when Plaid omits it. */
  category_confidence: string | null;
  category_icon_url: string | null;
  /** Stable merchant id across name variants. Group on this, display the name. */
  merchant_entity_id: string | null;
  website: string | null;
  logo_url: string | null;
  /**
   * Type of the primary counterparty: merchant, payment_app,
   * financial_institution, marketplace, payment_terminal, income_source.
   * `payment_app` is the useful one — it marks a Venmo or Cash App hop where
   * `counterparty` is the app, not who was actually paid.
   */
  counterparty_type: string | null;
  /**
   * The whole `counterparties` array as JSON, verbatim.
   *
   * Stored rather than flattened because it is variable-length and carries a
   * nested `account_numbers` object; flattening would need an arbitrary cap or
   * a child table. Query the denormalised `counterparty` and `counterparty_type`
   * columns; reach into this only when the full chain matters.
   */
  counterparties_json: string | null;
  /** online | in store | other. Held by the old `type` column before v3. */
  payment_channel: string;
  /** The real transaction type: ACH, bill payment, transfer, and similar. */
  transaction_code: string | null;
  check_number: string | null;
  /** Which owner of a joint account transacted, when the institution says. */
  account_owner: string | null;
  location_address: string | null;
  location_city: string | null;
  location_region: string | null;
  location_postal_code: string | null;
  location_country: string | null;
  /** Coordinates, not money — REAL is correct here, cents are not involved. */
  location_lat: number | null;
  location_lon: number | null;
  location_store_number: string | null;
  payment_meta_reference_number: string | null;
  payment_meta_ppd_id: string | null;
  payment_meta_payee: string | null;
  payment_meta_by_order_of: string | null;
  payment_meta_payer: string | null;
  payment_meta_payment_method: string | null;
  payment_meta_payment_processor: string | null;
  payment_meta_reason: string | null;
}

/** One page of `/transactions/sync` output. */
export interface SyncPage {
  added: TransactionRow[];
  modified: TransactionRow[];
  removedIds: string[];
}

/**
 * Bumped whenever the schema changes. Stored in `PRAGMA user_version` so a
 * database written by an older build is rejected loudly instead of failing later
 * with a confusing missing-column error — `CREATE TABLE IF NOT EXISTS` silently
 * no-ops against an existing table with different columns.
 */
const SCHEMA_VERSION = 3;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS items (
  id              TEXT PRIMARY KEY,
  access_token    TEXT NOT NULL,
  institution     TEXT NOT NULL,
  institution_id  TEXT,
  cursor          TEXT,
  created_at      INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS accounts (
  id                      TEXT PRIMARY KEY,
  item_id                 TEXT NOT NULL REFERENCES items(id),
  name                    TEXT NOT NULL,
  official_name           TEXT,
  institution             TEXT NOT NULL,
  type                    TEXT NOT NULL,
  subtype                 TEXT,
  mask                    TEXT,
  iso_currency_code       TEXT,
  available_balance_cents INTEGER,
  current_balance_cents   INTEGER,
  last_synced_at          INTEGER
);
CREATE TABLE IF NOT EXISTS transactions (
  id                             TEXT PRIMARY KEY,
  account_id                     TEXT NOT NULL REFERENCES accounts(id),
  date                           TEXT NOT NULL,
  description                    TEXT NOT NULL,
  amount_cents                   INTEGER NOT NULL,
  category_primary               TEXT,
  category_detailed              TEXT,
  counterparty                   TEXT,
  status                         TEXT NOT NULL,
  pending_transaction_id         TEXT,
  authorized_date                TEXT,
  authorized_datetime            TEXT,
  datetime                       TEXT,
  original_description           TEXT,
  iso_currency_code              TEXT,
  unofficial_currency_code       TEXT,
  category_confidence            TEXT,
  category_icon_url              TEXT,
  merchant_entity_id             TEXT,
  website                        TEXT,
  logo_url                       TEXT,
  counterparty_type              TEXT,
  counterparties_json            TEXT,
  payment_channel                TEXT NOT NULL,
  transaction_code               TEXT,
  check_number                   TEXT,
  account_owner                  TEXT,
  location_address               TEXT,
  location_city                  TEXT,
  location_region                TEXT,
  location_postal_code           TEXT,
  location_country               TEXT,
  location_lat                   REAL,
  location_lon                   REAL,
  location_store_number          TEXT,
  payment_meta_reference_number  TEXT,
  payment_meta_ppd_id            TEXT,
  payment_meta_payee             TEXT,
  payment_meta_by_order_of       TEXT,
  payment_meta_payer             TEXT,
  payment_meta_payment_method    TEXT,
  payment_meta_payment_processor TEXT,
  payment_meta_reason            TEXT
);
CREATE INDEX IF NOT EXISTS idx_txn_account_date ON transactions(account_id, date);
CREATE INDEX IF NOT EXISTS idx_txn_date ON transactions(date);
CREATE INDEX IF NOT EXISTS idx_txn_category ON transactions(category_primary);
CREATE INDEX IF NOT EXISTS idx_txn_merchant_entity ON transactions(merchant_entity_id);
CREATE INDEX IF NOT EXISTS idx_txn_authorized_date ON transactions(authorized_date);
CREATE INDEX IF NOT EXISTS idx_acct_item ON accounts(item_id);
`;

/** True when the core tables already exist, i.e. something wrote this file before. */
function hasCoreTables(db: Db): boolean {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM sqlite_master
       WHERE type = 'table' AND name IN ('items', 'accounts', 'transactions')`,
    )
    .get() as { n: number };
  return row.n > 0;
}

/**
 * Creates the schema on a fresh database, or verifies an existing one matches
 * this build. There are no migrations: the tool has never shipped, so any
 * mismatch means a database from a pre-release build, and the honest fix is to
 * delete it and re-sync from Plaid rather than carry migration code forever.
 *
 * THIS POLICY HAS AN EXPIRY. It holds only while no bank is linked. The database
 * stores the access tokens, and those are the one thing here that cannot be
 * re-downloaded — so once a real Item exists, "just delete it" means re-linking
 * every bank and consuming Item slots against the Trial plan's cap of 10.
 *
 * Make schema changes BEFORE linking. Once Items exist, replace this with
 * additive migrations rather than asking a user to throw their enrollments away.
 */
function applySchema(db: Db, dbPath: string): void {
  const version = db.pragma('user_version', { simple: true }) as number;

  if (version === SCHEMA_VERSION) return;

  if (version === 0) {
    // Version 0 with tables present means a pre-versioning build wrote this
    // file. Its columns differ (amounts were REAL dollars, not INTEGER cents),
    // and CREATE TABLE IF NOT EXISTS would leave them in place.
    if (hasCoreTables(db)) {
      throw new Error(
        `${dbPath} was created by an older build with an incompatible schema, and there ` +
          `are no migrations. Delete the file (and its -wal/-shm siblings), then run ` +
          `\`ledger auth\`. Transactions are all re-downloadable from Plaid; the access ` +
          `tokens are not, so every bank has to be linked again — which consumes Item ` +
          `slots against the Trial plan's cap of 10.`,
      );
    }
    db.exec(SCHEMA);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
    return;
  }

  if (version > SCHEMA_VERSION) {
    throw new Error(
      `${dbPath} has schema version ${version}, but this build expects ${SCHEMA_VERSION}. ` +
        `A newer version of ledger wrote this database — upgrade instead of downgrading.`,
    );
  }

  throw new Error(
    `${dbPath} has schema version ${version}, but this build expects ${SCHEMA_VERSION}. ` +
      `It was written by an older build and there are no migrations. Delete the file ` +
      `(and its -wal/-shm siblings), then run \`ledger auth\` to re-link and re-sync.`,
  );
}

export function readMeta(db: Db, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

function writeMeta(db: Db, key: string, value: string): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

/**
 * Binds a database file to the Plaid environment that created it.
 *
 * Access tokens are environment-scoped: a sandbox token means nothing to the
 * production host and vice versa. Nothing in the token's text says which it is,
 * so without this stamp, pointing config.json at the other environment produces
 * an authentication failure on every Item with no hint at the real cause.
 */
function enforceEnvironment(db: Db, dbPath: string, environment: PlaidEnvironment): void {
  const stamped = readMeta(db, 'environment');
  if (stamped === undefined) {
    writeMeta(db, 'environment', environment);
    return;
  }
  if (stamped !== environment) {
    // Names the two environments and the escape hatch, never the token values.
    throw new Error(
      `${dbPath} holds ${stamped} data, but the config selects ${environment}. ` +
        `Access tokens are not portable between environments. Point LEDGER_DATA_DIR at a ` +
        `separate directory for ${environment}, or delete this database to start over.`,
    );
  }
}

export function openDb(dbPath: string, environment: PlaidEnvironment): Db {
  const fresh = dbPath !== ':memory:' && !fs.existsSync(dbPath);
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  applySchema(db, dbPath);
  enforceEnvironment(db, dbPath, environment);
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

export interface RemovedItemCounts {
  accounts: number;
  transactions: number;
}

/**
 * Deletes an Item and everything hanging off it, in one transaction.
 *
 * Order is forced by the foreign keys: transactions reference accounts, which
 * reference items. Deleting an item first aborts mid-cascade with rows already
 * gone, which is why this is a single transaction rather than three statements.
 */
export function removeItem(db: Db, itemId: string): RemovedItemCounts {
  const run = db.transaction((): RemovedItemCounts => {
    const accountIds = listAccountIdsForItem(db, itemId);
    let transactions = 0;
    for (const batch of chunk(accountIds, MAX_BOUND_PARAMS)) {
      if (batch.length === 0) continue;
      const placeholders = batch.map(() => '?').join(',');
      transactions += db
        .prepare(`DELETE FROM transactions WHERE account_id IN (${placeholders})`)
        .run(...batch).changes;
    }
    const accounts = db.prepare('DELETE FROM accounts WHERE item_id = ?').run(itemId).changes;
    db.prepare('DELETE FROM items WHERE id = ?').run(itemId);
    return { accounts, transactions };
  });
  return run();
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
       iso_currency_code, available_balance_cents, current_balance_cents, last_synced_at
     ) VALUES (
       @id, @item_id, @name, @official_name, @institution, @type, @subtype, @mask,
       @iso_currency_code, @available_balance_cents, @current_balance_cents, NULL
     )
     ON CONFLICT(id) DO UPDATE SET
       item_id                 = excluded.item_id,
       name                    = excluded.name,
       official_name           = excluded.official_name,
       institution             = excluded.institution,
       type                    = excluded.type,
       subtype                 = excluded.subtype,
       mask                    = excluded.mask,
       iso_currency_code       = excluded.iso_currency_code,
       available_balance_cents = excluded.available_balance_cents,
       current_balance_cents   = excluded.current_balance_cents`,
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

/**
 * Every `transactions` column, in CREATE TABLE order. The single source for the
 * upsert SQL below, so a new column cannot be added to the table and forgotten
 * in the INSERT, the VALUES, or the ON CONFLICT list.
 */
const TXN_COLUMNS = [
  'id', 'account_id', 'date', 'description', 'amount_cents',
  'category_primary', 'category_detailed', 'counterparty', 'status',
  'pending_transaction_id', 'authorized_date', 'authorized_datetime', 'datetime',
  'original_description', 'iso_currency_code', 'unofficial_currency_code',
  'category_confidence', 'category_icon_url', 'merchant_entity_id',
  'website', 'logo_url', 'counterparty_type',
  'counterparties_json', 'payment_channel', 'transaction_code', 'check_number',
  'account_owner', 'location_address', 'location_city', 'location_region',
  'location_postal_code', 'location_country', 'location_lat', 'location_lon',
  'location_store_number', 'payment_meta_reference_number', 'payment_meta_ppd_id',
  'payment_meta_payee', 'payment_meta_by_order_of', 'payment_meta_payer',
  'payment_meta_payment_method', 'payment_meta_payment_processor',
  'payment_meta_reason',
] as const;

type TxnColumn = (typeof TXN_COLUMNS)[number];

/**
 * Compile-time guard that TXN_COLUMNS and TransactionRow describe the same set
 * of fields. Resolves to `true` when they agree and to a descriptive object type
 * when they do not, so the assignment below fails with the offending names in
 * the error text rather than a bare type mismatch.
 */
type ColumnsMatchRow = [Exclude<TxnColumn, keyof TransactionRow>] extends [never]
  ? [Exclude<keyof TransactionRow, TxnColumn>] extends [never]
    ? true
    : {
        error: 'TransactionRow declares fields absent from TXN_COLUMNS';
        missing: Exclude<keyof TransactionRow, TxnColumn>;
      }
  : {
      error: 'TXN_COLUMNS lists names absent from TransactionRow';
      extra: Exclude<TxnColumn, keyof TransactionRow>;
    };

/** Exported so `noUnusedLocals` keeps the guard above alive. */
export const COLUMNS_MATCH_ROW: ColumnsMatchRow = true;

/** Identity columns are never rewritten; a re-sent transaction keeps its keys. */
const TXN_MUTABLE_COLUMNS = TXN_COLUMNS.filter(c => c !== 'id' && c !== 'account_id');

const UPSERT_TRANSACTION_SQL = `INSERT INTO transactions (${TXN_COLUMNS.join(', ')})
   VALUES (${TXN_COLUMNS.map(c => `@${c}`).join(', ')})
   ON CONFLICT(id) DO UPDATE SET
     ${TXN_MUTABLE_COLUMNS.map(c => `${c} = excluded.${c}`).join(',\n     ')}`;

export function upsertTransactions(
  db: Db,
  rows: TransactionRow[],
): { inserted: number; updated: number } {
  if (rows.length === 0) return { inserted: 0, updated: 0 };
  const known = knownTransactionIds(
    db,
    rows.map(r => r.id),
  );
  const stmt = db.prepare(UPSERT_TRANSACTION_SQL);
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
