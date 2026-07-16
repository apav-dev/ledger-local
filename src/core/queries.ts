import { certsPresent, type TellerConfig } from './config.js';
import { listAccountRows, type AccountRow, type Db, type TransactionRow } from './db.js';

const STALE_MS = 24 * 3600 * 1000;

export interface QueryMeta {
  last_synced_at: number | null;
  stale: boolean;
}

function metaFor(db: Db, now: () => number, accountId?: string): QueryMeta {
  const rows = listAccountRows(db).filter(a => accountId === undefined || a.id === accountId);
  if (rows.length === 0) return { last_synced_at: null, stale: true };
  const syncTimes = rows.map(a => a.last_synced_at);
  if (syncTimes.some(t => t === null)) return { last_synced_at: null, stale: true };
  const oldest = Math.min(...(syncTimes as number[]));
  return { last_synced_at: oldest, stale: now() - oldest > STALE_MS };
}

export function listAccounts(
  db: Db,
  now: () => number = Date.now,
): { accounts: AccountRow[]; meta: QueryMeta } {
  return { accounts: listAccountRows(db), meta: metaFor(db, now) };
}

// All members include `| undefined` so zod-parsed / commander-derived objects
// assign cleanly under exactOptionalPropertyTypes.
export interface TxnFilters {
  accountId?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  category?: string | undefined;
  search?: string | undefined;
  status?: 'posted' | 'pending' | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

function txnWhere(f: TxnFilters): { where: string; params: Record<string, unknown> } {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};
  if (f.accountId !== undefined) { clauses.push('account_id = @accountId'); params['accountId'] = f.accountId; }
  if (f.from !== undefined) { clauses.push('date >= @from'); params['from'] = f.from; }
  if (f.to !== undefined) { clauses.push('date <= @to'); params['to'] = f.to; }
  if (f.category !== undefined) { clauses.push('category = @category'); params['category'] = f.category; }
  if (f.status !== undefined) { clauses.push('status = @status'); params['status'] = f.status; }
  if (f.search !== undefined) {
    clauses.push("(description LIKE @search OR counterparty LIKE @search)");
    params['search'] = `%${f.search}%`;
  }
  return { where: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

export function listTransactions(
  db: Db,
  f: TxnFilters = {},
  now: () => number = Date.now,
): { transactions: TransactionRow[]; total: number; meta: QueryMeta } {
  const { where, params } = txnWhere(f);
  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM transactions ${where}`).get(params) as { n: number }
  ).n;
  const transactions = db
    .prepare(
      `SELECT * FROM transactions ${where}
       ORDER BY date DESC, id DESC LIMIT @limit OFFSET @offset`,
    )
    .all({ ...params, limit: f.limit ?? 100, offset: f.offset ?? 0 }) as TransactionRow[];
  return { transactions, total, meta: metaFor(db, now, f.accountId) };
}

export type SpendingGroupBy = 'category' | 'merchant' | 'month' | 'account';

export interface SpendingFilters {
  from: string;
  to: string;
  groupBy: SpendingGroupBy;
  accountId?: string | undefined;
  includePending?: boolean | undefined;
  includeInflows?: boolean | undefined;
}

export interface SpendingGroup {
  key: string;
  total: number;
  count: number;
  share: number;
}

const GROUP_EXPR: Record<SpendingGroupBy, string> = {
  category: "COALESCE(category, 'uncategorized')",
  merchant: "COALESCE(NULLIF(counterparty, ''), 'unknown')",
  month: 'substr(date, 1, 7)',
  account: 'account_id',
};

export function spendingSummary(
  db: Db,
  f: SpendingFilters,
  now: () => number = Date.now,
): { groups: SpendingGroup[]; grandTotal: number; meta: QueryMeta } {
  const clauses = ['date >= @from', 'date <= @to'];
  const params: Record<string, unknown> = { from: f.from, to: f.to };
  if (f.accountId !== undefined) { clauses.push('account_id = @accountId'); params['accountId'] = f.accountId; }
  if (f.includePending !== true) clauses.push("status = 'posted'");
  // Spend = negative amounts (Teller sign convention). Sole definition of "spend".
  if (f.includeInflows !== true) clauses.push('amount < 0');

  const rows = db
    .prepare(
      `SELECT ${GROUP_EXPR[f.groupBy]} AS key,
              SUM(CASE WHEN amount < 0 THEN -amount ELSE amount END) AS total,
              COUNT(*) AS count
       FROM transactions
       WHERE ${clauses.join(' AND ')}
       GROUP BY key
       ORDER BY total DESC`,
    )
    .all(params) as Array<{ key: string; total: number; count: number }>;

  const grandTotal = rows.reduce((sum, r) => sum + r.total, 0);
  const groups = rows.map(r => ({
    ...r,
    share: grandTotal === 0 ? 0 : r.total / grandTotal,
  }));
  return { groups, grandTotal, meta: metaFor(db, now, f.accountId) };
}

export function authStatus(
  db: Db,
  cfg: TellerConfig,
): {
  environment: string;
  certsPresent: boolean;
  enrollments: Array<{ id: string; institution: string; accountCount: number }>;
} {
  const rows = db
    .prepare(
      `SELECT e.id, e.institution, COUNT(a.id) AS accountCount
       FROM enrollments e LEFT JOIN accounts a ON a.enrollment_id = e.id
       GROUP BY e.id ORDER BY e.created_at`,
    )
    .all() as Array<{ id: string; institution: string; accountCount: number }>;
  return { environment: cfg.environment, certsPresent: certsPresent(cfg), enrollments: rows };
}
