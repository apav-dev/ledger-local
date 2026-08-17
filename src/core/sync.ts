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
}

export function toTransactionRow(t: Transaction): TransactionRow {
  return {
    id: t.transaction_id,
    account_id: t.account_id,
    date: t.date,
    description: t.name,
    // Stored exactly as Plaid sends it: POSITIVE means money left the account.
    amount: t.amount,
    category_primary: t.personal_finance_category?.primary ?? null,
    category_detailed: t.personal_finance_category?.detailed ?? null,
    counterparty: t.merchant_name ?? null,
    status: t.pending ? 'pending' : 'posted',
    type: t.payment_channel,
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
    available_balance: a.balances.available,
    current_balance: a.balances.current,
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
): Promise<AccountSyncResult[]> {
  const names = new Map<string, string>();
  const tallies = new Map<string, Tally>();

  try {
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
      results.push({ accountId, accountName, ok: true, ...tally });
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
  } = {},
): Promise<AccountSyncResult[]> {
  const now = opts.now ?? Date.now;
  const maxPages = opts.maxPages ?? MAX_PAGES;

  let items = listItems(db);
  if (opts.itemId !== undefined) items = items.filter(i => i.id === opts.itemId);

  const results: AccountSyncResult[] = [];
  for (const item of items) {
    results.push(...(await syncItem(db, api, item, now, maxPages)));
  }

  if (opts.accountId === undefined) return results;
  // Keep Item-level failures visible: dropping them would report a filtered
  // sync as clean when the whole Item actually failed.
  return results.filter(r => r.accountId === opts.accountId || !r.ok);
}
