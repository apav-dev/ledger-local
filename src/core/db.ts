import fs from 'node:fs';
import Database from 'better-sqlite3';

export type Db = Database.Database;

export interface EnrollmentRow {
  id: string;
  access_token: string;
  institution: string;
  created_at: number;
}

export interface AccountRow {
  id: string;
  enrollment_id: string;
  name: string;
  institution: string;
  type: 'depository' | 'credit';
  subtype: string | null;
  last_four: string;
  currency: string;
  status: string;
  available_balance: number | null;
  ledger_balance: number | null;
  last_synced_at: number | null;
}

export type AccountUpsert = Omit<AccountRow, 'last_synced_at'>;

export interface TransactionRow {
  id: string;
  account_id: string;
  date: string;
  description: string;
  amount: number;
  category: string | null;
  counterparty: string | null;
  status: string;
  type: string;
  running_balance: number | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS enrollments (
  id            TEXT PRIMARY KEY,
  access_token  TEXT NOT NULL,
  institution   TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS accounts (
  id                 TEXT PRIMARY KEY,
  enrollment_id      TEXT NOT NULL REFERENCES enrollments(id),
  name               TEXT NOT NULL,
  institution        TEXT NOT NULL,
  type               TEXT NOT NULL,
  subtype            TEXT,
  last_four          TEXT NOT NULL,
  currency           TEXT NOT NULL,
  status             TEXT NOT NULL,
  available_balance  REAL,
  ledger_balance     REAL,
  last_synced_at     INTEGER
);
CREATE TABLE IF NOT EXISTS transactions (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES accounts(id),
  date            TEXT NOT NULL,
  description     TEXT NOT NULL,
  amount          REAL NOT NULL,
  category        TEXT,
  counterparty    TEXT,
  status          TEXT NOT NULL,
  type            TEXT NOT NULL,
  running_balance REAL
);
CREATE INDEX IF NOT EXISTS idx_txn_account_date ON transactions(account_id, date);
CREATE INDEX IF NOT EXISTS idx_txn_date ON transactions(date);
CREATE INDEX IF NOT EXISTS idx_txn_category ON transactions(category);
`;

export function openDb(dbPath: string): Db {
  const fresh = dbPath !== ':memory:' && !fs.existsSync(dbPath);
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  if (fresh) fs.chmodSync(dbPath, 0o600);
  return db;
}

export function upsertEnrollment(db: Db, row: EnrollmentRow): void {
  db.prepare(
    `INSERT INTO enrollments (id, access_token, institution, created_at)
     VALUES (@id, @access_token, @institution, @created_at)
     ON CONFLICT(id) DO UPDATE SET
       access_token = excluded.access_token,
       institution  = excluded.institution`,
  ).run(row);
}

export function listEnrollments(db: Db): EnrollmentRow[] {
  return db.prepare('SELECT * FROM enrollments ORDER BY created_at').all() as EnrollmentRow[];
}

export function upsertAccount(db: Db, row: AccountUpsert): void {
  db.prepare(
    `INSERT INTO accounts (
       id, enrollment_id, name, institution, type, subtype, last_four,
       currency, status, available_balance, ledger_balance, last_synced_at
     ) VALUES (
       @id, @enrollment_id, @name, @institution, @type, @subtype, @last_four,
       @currency, @status, @available_balance, @ledger_balance, NULL
     )
     ON CONFLICT(id) DO UPDATE SET
       enrollment_id     = excluded.enrollment_id,
       name              = excluded.name,
       institution       = excluded.institution,
       type              = excluded.type,
       subtype           = excluded.subtype,
       last_four         = excluded.last_four,
       currency          = excluded.currency,
       status            = excluded.status,
       available_balance = excluded.available_balance,
       ledger_balance    = excluded.ledger_balance`,
  ).run(row);
}

export function setAccountSynced(db: Db, accountId: string, ts: number): void {
  db.prepare('UPDATE accounts SET last_synced_at = ? WHERE id = ?').run(ts, accountId);
}

export function listAccountRows(db: Db): AccountRow[] {
  return db
    .prepare('SELECT * FROM accounts ORDER BY institution, name')
    .all() as AccountRow[];
}

export function knownTransactionIds(db: Db, ids: string[]): Set<string> {
  if (ids.length === 0) return new Set();
  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT id FROM transactions WHERE id IN (${placeholders})`)
    .all(...ids) as Array<{ id: string }>;
  return new Set(rows.map(r => r.id));
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
  const known = knownTransactionIds(db, rows.map(r => r.id));
  const stmt = db.prepare(
    `INSERT INTO transactions (
       id, account_id, date, description, amount, category, counterparty,
       status, type, running_balance
     ) VALUES (
       @id, @account_id, @date, @description, @amount, @category, @counterparty,
       @status, @type, @running_balance
     )
     ON CONFLICT(id) DO UPDATE SET
       date            = excluded.date,
       description     = excluded.description,
       amount          = excluded.amount,
       category        = excluded.category,
       counterparty    = excluded.counterparty,
       status          = excluded.status,
       type            = excluded.type,
       running_balance = excluded.running_balance`,
  );
  const insertAll = db.transaction((batch: TransactionRow[]) => {
    for (const row of batch) stmt.run(row);
  });
  insertAll(rows);
  const updated = rows.filter(r => known.has(r.id)).length;
  return { inserted: rows.length - updated, updated };
}
