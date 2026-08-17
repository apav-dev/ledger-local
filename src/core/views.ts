/**
 * The output boundary. Money is stored and aggregated as integer cents, but
 * every value that leaves this process — CLI `--json`, every MCP tool result —
 * is decimal dollars under its original field name.
 *
 * Why convert instead of exposing cents: an agent reading `amount_cents: 4599`
 * and reporting "$4,599" is a 100x error, a worse failure than the sign
 * confusion the MCP descriptions already have to fight. Dollars on output means
 * there is nothing new for a caller to know.
 *
 * Both frontends must go through here, or CLI and MCP output will drift apart.
 *
 * The view types are derived with `Omit` so adding a column to a row type breaks
 * compilation here rather than silently dropping the field from output.
 */
import type { AccountRow, TransactionRow } from './db.js';
import { centsToDollars, centsToDollarsOrNull } from './money.js';
import type { QueryMeta, SpendingGroup } from './queries.js';

export type AccountView = Omit<
  AccountRow,
  'available_balance_cents' | 'current_balance_cents'
> & {
  available_balance: number | null;
  current_balance: number | null;
};

export type TransactionView = Omit<TransactionRow, 'amount_cents'> & { amount: number };

export type SpendingGroupView = Omit<SpendingGroup, 'totalCents'> & { total: number };

export function accountView(row: AccountRow): AccountView {
  return {
    id: row.id,
    item_id: row.item_id,
    name: row.name,
    official_name: row.official_name,
    institution: row.institution,
    type: row.type,
    subtype: row.subtype,
    mask: row.mask,
    iso_currency_code: row.iso_currency_code,
    available_balance: centsToDollarsOrNull(row.available_balance_cents),
    current_balance: centsToDollarsOrNull(row.current_balance_cents),
    last_synced_at: row.last_synced_at,
  };
}

export function transactionView(row: TransactionRow): TransactionView {
  return {
    id: row.id,
    account_id: row.account_id,
    date: row.date,
    description: row.description,
    // Sign is untouched: POSITIVE is still money leaving the account.
    amount: centsToDollars(row.amount_cents),
    category_primary: row.category_primary,
    category_detailed: row.category_detailed,
    counterparty: row.counterparty,
    status: row.status,
    type: row.type,
    pending_transaction_id: row.pending_transaction_id,
  };
}

export function spendingGroupView(group: SpendingGroup): SpendingGroupView {
  return {
    key: group.key,
    total: centsToDollars(group.totalCents),
    count: group.count,
    share: group.share,
  };
}

// ------------------------------------------------- result envelopes

export function accountsResultView(result: { accounts: AccountRow[]; meta: QueryMeta }): {
  accounts: AccountView[];
  meta: QueryMeta;
} {
  return { accounts: result.accounts.map(accountView), meta: result.meta };
}

export function transactionsResultView(result: {
  transactions: TransactionRow[];
  total: number;
  meta: QueryMeta;
}): { transactions: TransactionView[]; total: number; meta: QueryMeta } {
  return {
    transactions: result.transactions.map(transactionView),
    total: result.total,
    meta: result.meta,
  };
}

export function spendingResultView(result: {
  groups: SpendingGroup[];
  grandTotalCents: number;
  meta: QueryMeta;
}): { groups: SpendingGroupView[]; grandTotal: number; meta: QueryMeta } {
  return {
    groups: result.groups.map(spendingGroupView),
    grandTotal: centsToDollars(result.grandTotalCents),
    meta: result.meta,
  };
}
