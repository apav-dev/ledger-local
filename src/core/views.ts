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
  const { amount_cents, ...rest } = row;
  return {
    ...rest,
    // The only transformation at this boundary. Sign is untouched: POSITIVE is
    // still money leaving the account.
    amount: centsToDollars(amount_cents),
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

/**
 * The subset of a transaction an agent reasons with.
 *
 * Storage keeps every field Plaid sends, because re-fetching is only free until
 * a bank is linked. A tool result is a different problem: forty-three fields
 * times a hundred rows is mostly nulls, and every null spends context the model
 * needs for the actual question. Nothing here is hidden — callers that want the
 * whole row ask for it.
 */
export type LeanTransactionView = Pick<
  TransactionView,
  | 'id'
  | 'account_id'
  | 'date'
  | 'authorized_date'
  | 'description'
  | 'amount'
  | 'category_primary'
  | 'category_detailed'
  | 'category_confidence'
  | 'counterparty'
  | 'counterparty_type'
  | 'merchant_entity_id'
  | 'payment_channel'
  | 'status'
  | 'iso_currency_code'
>;

export function leanTransactionView(row: TransactionRow): LeanTransactionView {
  const full = transactionView(row);
  return {
    id: full.id,
    account_id: full.account_id,
    date: full.date,
    authorized_date: full.authorized_date,
    description: full.description,
    amount: full.amount,
    category_primary: full.category_primary,
    category_detailed: full.category_detailed,
    category_confidence: full.category_confidence,
    counterparty: full.counterparty,
    counterparty_type: full.counterparty_type,
    merchant_entity_id: full.merchant_entity_id,
    payment_channel: full.payment_channel,
    status: full.status,
    iso_currency_code: full.iso_currency_code,
  };
}

export function transactionsResultView(
  result: { transactions: TransactionRow[]; total: number; meta: QueryMeta },
  opts: { verbose?: boolean | undefined } = {},
): {
  transactions: Array<TransactionView | LeanTransactionView>;
  total: number;
  meta: QueryMeta;
} {
  // Lean by default: the MCP server is the high-volume caller and the one with
  // a context budget. The CLI passes verbose and gets everything.
  const project = opts.verbose === true ? transactionView : leanTransactionView;
  return {
    transactions: result.transactions.map(project),
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
