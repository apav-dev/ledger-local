import type { AccountBase, Transaction } from 'plaid';
import {
  applySyncPage,
  listItems,
  setAccountSynced,
  upsertAccount,
  type AccountUpsert,
  type Db,
  type ItemRow,
  type TransactionRow,
} from './db.js';
import { toCents, toCentsOrNull } from './money.js';
import { isReauthRequired, type LedgerPlaidApi } from './plaid-client.js';

/** Plaid caps `/transactions/sync` at 500 updates per page. */
const PAGE_SIZE = 500;
/**
 * A non-advancing `next_cursor` paired with `has_more: true` would otherwise
 * spin forever. 500 pages is 250k updates — far past any real Item.
 */
const MAX_PAGES = 500;

export interface AccountSyncResult {
  accountId: string;
  accountName: string;
  ok: boolean;
  inserted: number;
  updated: number;
  removed: number;
  error?: string;
  needsReauth?: boolean | undefined;
  /**
   * True when `/transactions/refresh` ran for this account's Item before the
   * sync. Undefined on a normal sync, so the flag never appears in JSON unless
   * it happened.
   */
  refreshed?: boolean | undefined;
}

export function toTransactionRow(t: Transaction): TransactionRow {
  // Plaid orders counterparties by descending confidence, so [0] is the primary.
  // When merchant_name is set it is normally the same entity; when it is not,
  // this is the only name available.
  const primary = t.counterparties?.[0];
  return {
    id: t.transaction_id,
    account_id: t.account_id,
    date: t.date,
    authorized_date: t.authorized_date ?? null,
    authorized_datetime: t.authorized_datetime ?? null,
    datetime: t.datetime ?? null,
    description: t.name,
    original_description: t.original_description ?? null,
    // The one place decimal dollars become integer cents. The sign is kept
    // exactly as Plaid sends it: POSITIVE means money left the account.
    amount_cents: toCents(t.amount),
    // Both stored as sent. Plaid populates exactly one, and which one it picks
    // is information — coalescing them would erase that a value was unofficial.
    iso_currency_code: t.iso_currency_code ?? null,
    unofficial_currency_code: t.unofficial_currency_code ?? null,
    category_primary: t.personal_finance_category?.primary ?? null,
    category_detailed: t.personal_finance_category?.detailed ?? null,
    category_confidence: t.personal_finance_category?.confidence_level ?? null,
    category_icon_url: t.personal_finance_category_icon_url ?? null,
    counterparty: t.merchant_name ?? primary?.name ?? null,
    counterparty_type: primary?.type ?? null,
    // Only when Plaid sent one, so an absent array stays NULL rather than
    // becoming the string "[]" — those mean different things.
    counterparties_json:
      t.counterparties === undefined ? null : JSON.stringify(t.counterparties),
    merchant_entity_id: t.merchant_entity_id ?? null,
    website: t.website ?? null,
    logo_url: t.logo_url ?? null,
    payment_channel: t.payment_channel,
    transaction_code: t.transaction_code ?? null,
    check_number: t.check_number ?? null,
    account_owner: t.account_owner ?? null,
    location_address: t.location?.address ?? null,
    location_city: t.location?.city ?? null,
    location_region: t.location?.region ?? null,
    location_postal_code: t.location?.postal_code ?? null,
    location_country: t.location?.country ?? null,
    location_lat: t.location?.lat ?? null,
    location_lon: t.location?.lon ?? null,
    location_store_number: t.location?.store_number ?? null,
    payment_meta_reference_number: t.payment_meta?.reference_number ?? null,
    payment_meta_ppd_id: t.payment_meta?.ppd_id ?? null,
    payment_meta_payee: t.payment_meta?.payee ?? null,
    payment_meta_by_order_of: t.payment_meta?.by_order_of ?? null,
    payment_meta_payer: t.payment_meta?.payer ?? null,
    payment_meta_payment_method: t.payment_meta?.payment_method ?? null,
    payment_meta_payment_processor: t.payment_meta?.payment_processor ?? null,
    payment_meta_reason: t.payment_meta?.reason ?? null,
    status: t.pending ? 'pending' : 'posted',
    pending_transaction_id: t.pending_transaction_id ?? null,
  };
}

export function toAccountUpsert(
  a: AccountBase,
  itemId: string,
  institution: string,
): AccountUpsert {
  return {
    id: a.account_id,
    item_id: itemId,
    name: a.name,
    official_name: a.official_name,
    institution,
    type: String(a.type),
    subtype: a.subtype === null || a.subtype === undefined ? null : String(a.subtype),
    mask: a.mask,
    // Plaid populates exactly one of these; unofficial covers crypto and similar.
    iso_currency_code:
      a.balances.iso_currency_code ?? a.balances.unofficial_currency_code ?? null,
    available_balance_cents: toCentsOrNull(a.balances.available),
    current_balance_cents: toCentsOrNull(a.balances.current),
    limit_cents: toCentsOrNull(a.balances.limit),
  };
}

interface Tally {
  inserted: number;
  updated: number;
  removed: number;
}

function bump(tallies: Map<string, Tally>, accountId: string, field: keyof Tally): void {
  const current = tallies.get(accountId) ?? { inserted: 0, updated: 0, removed: 0 };
  current[field] += 1;
  tallies.set(accountId, current);
}

/**
 * Syncs one Item. Plaid's sync unit is the Item, but results are reported per
 * account because that is what a user reads — counts are attributed using the
 * `account_id` carried on every added, modified, and removed record.
 */
async function syncItem(
  db: Db,
  api: LedgerPlaidApi,
  item: ItemRow,
  now: () => number,
  maxPages: number,
  force: boolean,
): Promise<AccountSyncResult[]> {
  const names = new Map<string, string>();
  const tallies = new Map<string, Tally>();

  try {
    // Before anything else, or the pull it triggers cannot be picked up by the
    // sync below. Inside the try so a refresh failure is reported as a failed
    // Item rather than silently syncing stale data as if the force had worked.
    if (force) await api.refreshTransactions(item.access_token);

    // `/accounts/balance/get` rather than the `accounts` in the sync response:
    // balances elsewhere may be cached, and this endpoint forces a live read.
    const accounts = await api.getAccounts(item.access_token);
    for (const account of accounts) {
      upsertAccount(db, toAccountUpsert(account, item.id, item.institution));
      names.set(account.account_id, account.name);
      tallies.set(account.account_id, { inserted: 0, updated: 0, removed: 0 });
    }

    let cursor = item.cursor;
    for (let page = 0; page < maxPages; page++) {
      const response = await api.syncTransactions(item.access_token, cursor, PAGE_SIZE);

      // The sync response carries accounts too. Upserting them costs no extra
      // call and guarantees every transaction below has a parent row, so a
      // freshly opened account cannot trip the foreign key.
      for (const account of response.accounts) {
        if (!names.has(account.account_id)) {
          upsertAccount(db, toAccountUpsert(account, item.id, item.institution));
          names.set(account.account_id, account.name);
        }
      }

      const added = response.added.map(toTransactionRow);
      const modified = response.modified.map(toTransactionRow);
      const removedIds = response.removed
        .map(r => r.transaction_id)
        .filter((id): id is string => typeof id === 'string');

      // Attribute before applying: `applySyncPage` returns totals, not a
      // per-account breakdown.
      for (const row of added) bump(tallies, row.account_id, 'inserted');
      for (const row of modified) bump(tallies, row.account_id, 'updated');
      for (const removal of response.removed) bump(tallies, removal.account_id, 'removed');

      applySyncPage(db, item.id, { added, modified, removedIds }, response.next_cursor);

      if (!response.has_more) break;
      if (response.next_cursor === cursor) {
        throw new Error(
          `Plaid returned has_more with an unchanged cursor for item ${item.id} — aborting to avoid an endless sync`,
        );
      }
      cursor = response.next_cursor;

      if (page === maxPages - 1) {
        throw new Error(
          `pagination exceeded ${maxPages} pages for item ${item.id} — aborting sync for this item`,
        );
      }
    }

    const ts = now();
    const results: AccountSyncResult[] = [];
    for (const [accountId, accountName] of names) {
      setAccountSynced(db, accountId, ts);
      const tally = tallies.get(accountId) ?? { inserted: 0, updated: 0, removed: 0 };
      results.push({
        accountId,
        accountName,
        ok: true,
        ...tally,
        refreshed: force ? true : undefined,
      });
    }
    return results;
  } catch (error) {
    // One synthetic row per failed Item. Its accounts keep their old
    // last_synced_at, so reads still report them as stale.
    return [
      {
        accountId: `item:${item.id}`,
        accountName: item.institution,
        ok: false,
        inserted: 0,
        updated: 0,
        removed: 0,
        error: error instanceof Error ? error.message : String(error),
        ...(isReauthRequired(error) ? { needsReauth: true } : {}),
        refreshed: force ? true : undefined,
      },
    ];
  }
}

export async function syncAll(
  db: Db,
  api: LedgerPlaidApi,
  // `| undefined` members: callers pass through optional values under
  // exactOptionalPropertyTypes.
  opts: {
    /**
     * Narrows to the Item that owns this account. Plaid has no per-account
     * sync, so the whole Item is refreshed and only this account is reported.
     */
    accountId?: string | undefined;
    itemId?: string | undefined;
    now?: (() => number) | undefined;
    maxPages?: number | undefined;
    force?: boolean | undefined;
  } = {},
): Promise<AccountSyncResult[]> {
  const now = opts.now ?? Date.now;
  const maxPages = opts.maxPages ?? MAX_PAGES;

  let items = listItems(db);
  if (opts.itemId !== undefined) items = items.filter(i => i.id === opts.itemId);

  const results: AccountSyncResult[] = [];
  for (const item of items) {
    results.push(...(await syncItem(db, api, item, now, maxPages, opts.force === true)));
  }

  if (opts.accountId === undefined) return results;
  // Keep Item-level failures visible: dropping them would report a filtered
  // sync as clean when the whole Item actually failed.
  return results.filter(r => r.accountId === opts.accountId || !r.ok);
}
