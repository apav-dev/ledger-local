import {
  countTransactions,
  knownTransactionIds,
  listEnrollments,
  setAccountSynced,
  upsertAccount,
  upsertTransactions,
  type AccountUpsert,
  type Db,
  type TransactionRow,
} from './db.js';
import type {
  TellerAccount,
  TellerApi,
  TellerBalance,
  TellerTransaction,
} from './types.js';

const PAGE_SIZE = 1000;

export interface AccountSyncResult {
  accountId: string;
  accountName: string;
  ok: boolean;
  inserted: number;
  updated: number;
  error?: string;
}

function parseMoney(value: string | null): number | null {
  if (value === null) return null;
  const n = Number.parseFloat(value);
  return Number.isNaN(n) ? null : n;
}

export function toAccountUpsert(a: TellerAccount, balance: TellerBalance | null): AccountUpsert {
  return {
    id: a.id,
    enrollment_id: a.enrollment_id,
    name: a.name,
    institution: a.institution.name,
    type: a.type,
    subtype: a.subtype ?? null,
    last_four: a.last_four,
    currency: a.currency,
    status: a.status,
    available_balance: balance ? parseMoney(balance.available) : null,
    ledger_balance: balance ? parseMoney(balance.ledger) : null,
  };
}

export function toTransactionRow(t: TellerTransaction): TransactionRow {
  return {
    id: t.id,
    account_id: t.account_id,
    date: t.date,
    description: t.description,
    amount: Number.parseFloat(t.amount),
    category: t.details.category ?? null,
    counterparty: t.details.counterparty?.name ?? null,
    status: t.status,
    type: t.type,
    running_balance: parseMoney(t.running_balance),
  };
}

async function syncAccount(
  db: Db,
  api: TellerApi,
  accessToken: string,
  tellerAccount: TellerAccount,
  now: () => number,
): Promise<AccountSyncResult> {
  const base = { accountId: tellerAccount.id, accountName: tellerAccount.name };
  try {
    const balance = await api.getBalance(accessToken, tellerAccount.id);
    upsertAccount(db, toAccountUpsert(tellerAccount, balance));

    const isInitial = countTransactions(db, tellerAccount.id) === 0;
    let inserted = 0;
    let updated = 0;
    let fromId: string | undefined;

    for (;;) {
      const opts: { count: number; fromId?: string } = { count: PAGE_SIZE };
      if (fromId !== undefined) opts.fromId = fromId;
      const page = await api.listTransactions(accessToken, tellerAccount.id, opts);
      if (page.length === 0) break;

      const known = knownTransactionIds(db, page.map(t => t.id));
      const counts = upsertTransactions(db, page.map(toTransactionRow));
      inserted += counts.inserted;
      updated += counts.updated;

      if (!isInitial) {
        const pageFullyKnown = page.every(t => known.has(t.id));
        if (pageFullyKnown) break; // caught up to existing history
        if (page.length < PAGE_SIZE) break; // short page: no older data left
      }
      // Initial sync keeps paging until the API returns a genuinely empty page
      // (handled by the `page.length === 0` check above) — a short-but-nonempty
      // page does not by itself mean history is exhausted.
      const last = page[page.length - 1];
      if (last === undefined) break;
      fromId = last.id;
    }

    setAccountSynced(db, tellerAccount.id, now());
    return { ...base, ok: true, inserted, updated };
  } catch (error) {
    return {
      ...base,
      ok: false,
      inserted: 0,
      updated: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function syncAll(
  db: Db,
  api: TellerApi,
  // `| undefined` members: callers pass through optional values under exactOptionalPropertyTypes
  opts: { accountId?: string | undefined; now?: (() => number) | undefined } = {},
): Promise<AccountSyncResult[]> {
  const now = opts.now ?? Date.now;
  const results: AccountSyncResult[] = [];
  for (const enrollment of listEnrollments(db)) {
    let accounts: TellerAccount[];
    try {
      accounts = await api.listAccounts(enrollment.access_token);
    } catch (error) {
      results.push({
        accountId: `enrollment:${enrollment.id}`,
        accountName: enrollment.institution,
        ok: false,
        inserted: 0,
        updated: 0,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    for (const acct of accounts) {
      if (opts.accountId !== undefined && acct.id !== opts.accountId) continue;
      results.push(await syncAccount(db, api, enrollment.access_token, acct, now));
    }
  }
  return results;
}
