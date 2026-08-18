import type { TransactionStream, TransactionsRecurringGetResponse } from 'plaid';
import {
  lastRecurringRefreshAt,
  listAccountIdsForItem,
  listItems,
  listRecurringStreamRows,
  replaceRecurringStreams,
  type Db,
  type RecurringStreamRow,
} from './db.js';
import { toCentsOrNull } from './money.js';
import {
  isConsentRequired,
  isReauthRequired,
  type LedgerPlaidApi,
} from './plaid-client.js';
import type { QueryMeta } from './queries.js';

const STALE_MS = 24 * 3600 * 1000;

/**
 * Deliberately does not mention `ledger auth consent`. Recurring Transactions is
 * not grantable through Link consent — Plaid rejects it as an
 * additional_consented_product — so the only real fixes are the dashboard or the
 * institution.
 */
const PRODUCT_HINT =
  'Plaid refused recurring transactions for this bank. This is not something ' +
  '`ledger auth consent` can grant: Recurring Transactions is enabled per client_id at ' +
  'Dashboard > Developers > Products, not per Item. Check it is enabled there, and note ' +
  'that not every institution supports it.';

function toRow(
  s: TransactionStream,
  itemId: string,
  direction: 'inflow' | 'outflow',
  refreshedAt: number,
): RecurringStreamRow {
  return {
    stream_id: s.stream_id,
    item_id: itemId,
    account_id: s.account_id,
    direction,
    description: s.description,
    merchant_name: s.merchant_name,
    category_primary: s.personal_finance_category?.primary ?? null,
    category_detailed: s.personal_finance_category?.detailed ?? null,
    frequency: String(s.frequency),
    status: String(s.status),
    // SQLite has no boolean type.
    is_active: s.is_active ? 1 : 0,
    first_date: s.first_date,
    last_date: s.last_date,
    predicted_next_date: s.predicted_next_date ?? null,
    // Plaid types both amounts as optional. Sign is left Plaid-native: positive
    // is money leaving the account, so an outflow stream reads positive.
    average_amount_cents: toCentsOrNull(s.average_amount.amount),
    last_amount_cents: toCentsOrNull(s.last_amount.amount),
    transaction_count: s.transaction_ids.length,
    refreshed_at: refreshedAt,
  };
}

/** Flattens Plaid's two stream arrays into rows, tagging each with its direction. */
export function toRecurringRows(
  response: TransactionsRecurringGetResponse,
  itemId: string,
  refreshedAt: number,
): RecurringStreamRow[] {
  return [
    ...response.outflow_streams.map(s => toRow(s, itemId, 'outflow', refreshedAt)),
    ...response.inflow_streams.map(s => toRow(s, itemId, 'inflow', refreshedAt)),
  ];
}

export interface RecurringRefreshResult {
  itemId: string;
  institution: string;
  ok: boolean;
  streams: number;
  removed: number;
  error?: string;
  needsReauth?: boolean | undefined;
  needsConsent?: boolean | undefined;
}

/**
 * Refetches recurring streams for every Item, or one.
 *
 * Per-Item failures are collected rather than thrown: one bank that needs
 * re-authentication must not hide the streams of every other bank. This mirrors
 * how `syncAll` reports.
 */
export async function refreshRecurring(
  db: Db,
  api: LedgerPlaidApi,
  opts: { itemId?: string | undefined; now?: (() => number) | undefined } = {},
): Promise<RecurringRefreshResult[]> {
  const now = opts.now ?? Date.now;
  const items = listItems(db).filter(i => opts.itemId === undefined || i.id === opts.itemId);
  const results: RecurringRefreshResult[] = [];

  for (const item of items) {
    try {
      const response = await api.getRecurringStreams(item.access_token);
      const rows = toRecurringRows(response, item.id, now());

      // A stream can name an account this Item no longer holds — Plaid keeps
      // history for closed accounts. Inserting it violates the foreign key and
      // would abort the whole snapshot, so drop it instead: one orphaned stream
      // must not cost the user every other stream on the bank.
      const known = new Set(listAccountIdsForItem(db, item.id));
      const insertable = rows.filter(r => known.has(r.account_id));

      const removed = replaceRecurringStreams(db, item.id, insertable);
      results.push({
        itemId: item.id,
        institution: item.institution,
        ok: true,
        streams: insertable.length,
        removed,
      });
    } catch (error) {
      const consent = isConsentRequired(error);
      results.push({
        itemId: item.id,
        institution: item.institution,
        ok: false,
        streams: 0,
        removed: 0,
        error: consent ? PRODUCT_HINT : error instanceof Error ? error.message : String(error),
        // Undefined rather than false so the JSON stays quiet in the common case.
        needsReauth: isReauthRequired(error) ? true : undefined,
        needsConsent: consent ? true : undefined,
      });
    }
  }

  return results;
}

export interface RecurringFilters {
  direction?: 'inflow' | 'outflow' | undefined;
  /** Hide TOMBSTONED and other ended streams. */
  activeOnly?: boolean | undefined;
  frequency?: string | undefined;
}

/**
 * Reads stored streams. Staleness is measured against the recurring refresh
 * time, not the transaction sync time — the two advance independently, and
 * reporting a fresh transaction sync as a fresh stream snapshot would be a lie.
 */
export function listRecurring(
  db: Db,
  f: RecurringFilters = {},
  now: () => number = Date.now,
): { streams: RecurringStreamRow[]; meta: QueryMeta } {
  const all = listRecurringStreamRows(db);
  const streams = all.filter(s => {
    if (f.direction !== undefined && s.direction !== f.direction) return false;
    if (f.activeOnly === true && s.is_active !== 1) return false;
    if (f.frequency !== undefined && s.frequency.toUpperCase() !== f.frequency.toUpperCase()) {
      return false;
    }
    return true;
  });

  const refreshedAt = lastRecurringRefreshAt(db);
  const meta: QueryMeta =
    refreshedAt === null
      ? { last_synced_at: null, stale: true }
      : { last_synced_at: refreshedAt, stale: now() - refreshedAt > STALE_MS };

  return { streams, meta };
}
