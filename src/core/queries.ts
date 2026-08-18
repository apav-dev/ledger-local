import type { LedgerConfig } from './config.js';
import { listAccountRows, listItems, type AccountRow, type Db, type TransactionRow } from './db.js';
import { assertDateOrder, resolveDate } from './dates.js';

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
  if (f.category !== undefined) {
    // Case-insensitive, and NULL-aware: `category_primary = @category` can never
    // match a NULL row, so UNCATEGORIZED needs its own IS NULL branch.
    if (f.category.toUpperCase() === 'UNCATEGORIZED') {
      clauses.push('category_primary IS NULL');
    } else {
      clauses.push('UPPER(category_primary) = UPPER(@category)');
      params['category'] = f.category;
    }
  }
  if (f.status !== undefined) { clauses.push('status = @status'); params['status'] = f.status; }
  if (f.search !== undefined) {
    // original_description is the raw bank memo. It carries store numbers and
    // reference codes that Plaid strips from `description`, which is exactly
    // what someone pasting a line off a statement will search for.
    clauses.push(
      '(description LIKE @search OR counterparty LIKE @search OR original_description LIKE @search)',
    );
    params['search'] = `%${f.search}%`;
  }
  return { where: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

export function listTransactions(
  db: Db,
  f: TxnFilters = {},
  now: () => number = Date.now,
): { transactions: TransactionRow[]; total: number; meta: QueryMeta } {
  const from = f.from !== undefined ? resolveDate(f.from, now) : undefined;
  const to = f.to !== undefined ? resolveDate(f.to, now) : undefined;
  if (from !== undefined && to !== undefined) assertDateOrder(from, to);
  if (f.category !== undefined) assertKnownCategory(db, f.category);

  const { where, params } = txnWhere({ ...f, from, to });
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

export type SpendingGroupBy =
  | 'category'
  | 'merchant'
  | 'month'
  | 'account'
  | 'payment_channel';

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
  /** Integer cents, always positive. Converted to dollars in views.ts. */
  totalCents: number;
  count: number;
  share: number;
}

/**
 * How rows are bucketed. Merchant buckets on the stable entity id so
 * "Amazon" and "AMZN Mktp US*2K4" land together, falling back to the display
 * name for institutions that report no entity id.
 */
const GROUP_EXPR: Record<SpendingGroupBy, string> = {
  category: "COALESCE(category_primary, 'UNCATEGORIZED')",
  merchant:
    "COALESCE(NULLIF(merchant_entity_id, ''), NULLIF(counterparty, ''), 'unknown')",
  month: 'substr(date, 1, 7)',
  account: 'account_id',
  payment_channel: "COALESCE(NULLIF(payment_channel, ''), 'other')",
};

/**
 * What the bucket is called in the output. Identical to GROUP_EXPR except for
 * merchant, where the bucket is an opaque entity id nobody wants to read — so
 * the label is a name drawn from the bucket's rows instead.
 *
 * MIN() rather than MAX() only for determinism; any row's name is equally valid
 * and they are variants of the same merchant by construction.
 */
const KEY_EXPR: Record<SpendingGroupBy, string> = {
  ...GROUP_EXPR,
  merchant: "COALESCE(MIN(NULLIF(counterparty, '')), 'unknown')",
};

export interface CategoryCount {
  category: string;
  count: number;
}

/**
 * The only source of truth for "what categories exist": Plaid's SDK types
 * `personal_finance_category.primary` as a bare `string`, no enum, and ships no
 * endpoint that enumerates the taxonomy. What's actually in the local cache is
 * all there is to validate `--category` against or offer for discovery.
 */
function distinctCategoryCounts(db: Db): CategoryCount[] {
  return db
    .prepare(
      `SELECT ${GROUP_EXPR['category']} AS category, COUNT(*) AS count
       FROM transactions
       GROUP BY category
       ORDER BY count DESC`,
    )
    .all() as CategoryCount[];
}

export function listCategories(
  db: Db,
  now: () => number = Date.now,
): { categories: CategoryCount[]; meta: QueryMeta } {
  return { categories: distinctCategoryCounts(db), meta: metaFor(db, now) };
}

export function assertKnownCategory(db: Db, category: string): void {
  const known = distinctCategoryCounts(db).map(c => c.category);
  if (known.length === 0) return; // nothing synced yet — nothing to validate against
  if (!known.some(c => c.toUpperCase() === category.toUpperCase())) {
    throw new Error(
      `category "${category}" is not known. Valid values: ${known.join(', ')}. ` +
        'Run `ledger categories` (or the list_categories MCP tool) to see this list with counts.',
    );
  }
}

export function spendingSummary(
  db: Db,
  f: SpendingFilters,
  now: () => number = Date.now,
): { groups: SpendingGroup[]; grandTotalCents: number; meta: QueryMeta } {
  const from = resolveDate(f.from, now);
  const to = resolveDate(f.to, now);
  assertDateOrder(from, to);

  const clauses = ['date >= @from', 'date <= @to'];
  const params: Record<string, unknown> = { from, to };
  if (f.accountId !== undefined) { clauses.push('account_id = @accountId'); params['accountId'] = f.accountId; }
  if (f.includePending !== true) clauses.push("status = 'posted'");
  // Spend = POSITIVE amounts under Plaid's sign convention, which is the inverse
  // of a bank statement. Sole definition of "spend" in the codebase.
  if (f.includeInflows !== true) clauses.push('amount_cents > 0');

  const rows = db
    .prepare(
      // Totals are reported as positive magnitudes regardless of direction, so a
      // caller comparing groups never has to reason about the sign. Summing
      // INTEGER cents is exact — no rounding error can accumulate here.
      `SELECT ${KEY_EXPR[f.groupBy]} AS key,
              SUM(ABS(amount_cents)) AS totalCents,
              COUNT(*) AS count
       FROM transactions
       WHERE ${clauses.join(' AND ')}
       GROUP BY ${GROUP_EXPR[f.groupBy]}
       ORDER BY totalCents DESC`,
    )
    .all(params) as Array<{ key: string; totalCents: number; count: number }>;

  const grandTotalCents = rows.reduce((sum, r) => sum + r.totalCents, 0);
  const groups = rows.map(r => ({
    ...r,
    share: grandTotalCents === 0 ? 0 : r.totalCents / grandTotalCents,
  }));
  return { groups, grandTotalCents, meta: metaFor(db, now, f.accountId) };
}

export interface AuthStatusItem {
  id: string;
  institution: string;
  accountCount: number;
  /** False until the first successful sync completes for this Item. */
  synced: boolean;
}

export function authStatus(
  db: Db,
  cfg: Pick<LedgerConfig, 'environment'>,
): {
  environment: string;
  items: AuthStatusItem[];
} {
  const rows = db
    .prepare(
      `SELECT i.id, i.institution, i.cursor AS cursor, COUNT(a.id) AS accountCount
       FROM items i LEFT JOIN accounts a ON a.item_id = i.id
       GROUP BY i.id ORDER BY i.created_at`,
    )
    .all() as Array<{
    id: string;
    institution: string;
    cursor: string | null;
    accountCount: number;
  }>;

  return {
    environment: cfg.environment,
    items: rows.map(r => ({
      id: r.id,
      institution: r.institution,
      accountCount: r.accountCount,
      synced: r.cursor !== null,
    })),
  };
}

/** Item ids that exist but have never completed a sync. */
export function unsyncedItemIds(db: Db): string[] {
  return listItems(db)
    .filter(i => i.cursor === null)
    .map(i => i.id);
}
