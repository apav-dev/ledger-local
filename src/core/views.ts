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
import type {
  AccountRow,
  CreditAprRow,
  CreditLiabilityRow,
  MortgageLiabilityRow,
  RecurringStreamRow,
  TransactionRow,
} from './db.js';
import type { LiabilitiesQueryResult } from './liabilities.js';
import { centsToDollars, centsToDollarsOrNull } from './money.js';
import type { QueryMeta, SpendingGroup } from './queries.js';

export type AccountView = Omit<
  AccountRow,
  'available_balance_cents' | 'current_balance_cents' | 'limit_cents'
> & {
  available_balance: number | null;
  current_balance: number | null;
  limit: number | null;
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
    limit: centsToDollarsOrNull(row.limit_cents),
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

/**
 * `is_active` becomes a real boolean here rather than SQLite's 0/1. An agent
 * reading `is_active: 0` as truthy would report a cancelled subscription as
 * live, which is the same class of error as reading cents as dollars.
 */
export type RecurringStreamView = Omit<
  RecurringStreamRow,
  'average_amount_cents' | 'last_amount_cents' | 'is_active'
> & {
  average_amount: number | null;
  last_amount: number | null;
  is_active: boolean;
};

export function recurringStreamView(row: RecurringStreamRow): RecurringStreamView {
  return {
    stream_id: row.stream_id,
    item_id: row.item_id,
    account_id: row.account_id,
    direction: row.direction,
    description: row.description,
    merchant_name: row.merchant_name,
    category_primary: row.category_primary,
    category_detailed: row.category_detailed,
    frequency: row.frequency,
    status: row.status,
    is_active: row.is_active === 1,
    first_date: row.first_date,
    last_date: row.last_date,
    predicted_next_date: row.predicted_next_date,
    // Sign is untouched: an outflow stream reads POSITIVE, as everywhere else.
    average_amount: centsToDollarsOrNull(row.average_amount_cents),
    last_amount: centsToDollarsOrNull(row.last_amount_cents),
    transaction_count: row.transaction_count,
    refreshed_at: row.refreshed_at,
  };
}

export function recurringResultView(result: {
  streams: RecurringStreamRow[];
  meta: QueryMeta;
}): { streams: RecurringStreamView[]; meta: QueryMeta } {
  return { streams: result.streams.map(recurringStreamView), meta: result.meta };
}

/** SQLite 0/1/NULL → real boolean. Bare `=== 1` would report unreported PMI as no PMI. */
function toBool(value: number | null): boolean | null {
  return value === null ? null : value === 1;
}

export type MortgageView = Omit<
  MortgageLiabilityRow,
  | 'escrow_balance_cents'
  | 'current_late_fee_cents'
  | 'last_payment_amount_cents'
  | 'next_monthly_payment_cents'
  | 'origination_principal_amount_cents'
  | 'past_due_amount_cents'
  | 'ytd_interest_paid_cents'
  | 'ytd_principal_paid_cents'
  | 'has_pmi'
  | 'has_prepayment_penalty'
> & {
  escrow_balance: number | null;
  current_late_fee: number | null;
  last_payment_amount: number | null;
  next_monthly_payment: number | null;
  origination_principal_amount: number | null;
  past_due_amount: number | null;
  ytd_interest_paid: number | null;
  ytd_principal_paid: number | null;
  has_pmi: boolean | null;
  has_prepayment_penalty: boolean | null;
  institution: string | null;
  account_name: string | null;
  account_mask: string | null;
  outstanding_principal: number | null;
};

export function mortgageView(
  row: MortgageLiabilityRow,
  account: AccountRow | undefined,
): MortgageView {
  return {
    account_id: row.account_id,
    item_id: row.item_id,
    refreshed_at: row.refreshed_at,
    // Percentages are percentages. 6.125 means 6.125%.
    interest_rate_percentage: row.interest_rate_percentage,
    interest_rate_type: row.interest_rate_type,
    escrow_balance: centsToDollarsOrNull(row.escrow_balance_cents),
    current_late_fee: centsToDollarsOrNull(row.current_late_fee_cents),
    has_pmi: toBool(row.has_pmi),
    has_prepayment_penalty: toBool(row.has_prepayment_penalty),
    last_payment_amount: centsToDollarsOrNull(row.last_payment_amount_cents),
    last_payment_date: row.last_payment_date,
    loan_type_description: row.loan_type_description,
    loan_term: row.loan_term,
    maturity_date: row.maturity_date,
    next_monthly_payment: centsToDollarsOrNull(row.next_monthly_payment_cents),
    next_payment_due_date: row.next_payment_due_date,
    origination_date: row.origination_date,
    origination_principal_amount: centsToDollarsOrNull(row.origination_principal_amount_cents),
    past_due_amount: centsToDollarsOrNull(row.past_due_amount_cents),
    property_street: row.property_street,
    property_city: row.property_city,
    property_region: row.property_region,
    property_postal_code: row.property_postal_code,
    property_country: row.property_country,
    ytd_interest_paid: centsToDollarsOrNull(row.ytd_interest_paid_cents),
    ytd_principal_paid: centsToDollarsOrNull(row.ytd_principal_paid_cents),
    institution: account?.institution ?? null,
    account_name: account?.name ?? null,
    account_mask: account?.mask ?? null,
    // Joined from accounts. Never derived from origination_principal_amount.
    outstanding_principal: centsToDollarsOrNull(account?.current_balance_cents ?? null),
  };
}

export type CreditView = Omit<
  CreditLiabilityRow,
  | 'last_payment_amount_cents'
  | 'last_statement_balance_cents'
  | 'minimum_payment_amount_cents'
  | 'is_overdue'
> & {
  last_payment_amount: number | null;
  last_statement_balance: number | null;
  minimum_payment_amount: number | null;
  is_overdue: boolean | null;
  institution: string | null;
  account_name: string | null;
  account_mask: string | null;
};

export function creditView(row: CreditLiabilityRow, account: AccountRow | undefined): CreditView {
  return {
    account_id: row.account_id,
    item_id: row.item_id,
    refreshed_at: row.refreshed_at,
    is_overdue: toBool(row.is_overdue),
    last_payment_amount: centsToDollarsOrNull(row.last_payment_amount_cents),
    last_payment_date: row.last_payment_date,
    last_statement_issue_date: row.last_statement_issue_date,
    last_statement_balance: centsToDollarsOrNull(row.last_statement_balance_cents),
    minimum_payment_amount: centsToDollarsOrNull(row.minimum_payment_amount_cents),
    next_payment_due_date: row.next_payment_due_date,
    purchase_apr_percentage: row.purchase_apr_percentage,
    institution: account?.institution ?? null,
    account_name: account?.name ?? null,
    account_mask: account?.mask ?? null,
  };
}

export type AprView = Omit<
  CreditAprRow,
  'balance_subject_to_apr_cents' | 'interest_charge_amount_cents'
> & {
  balance_subject_to_apr: number | null;
  interest_charge_amount: number | null;
};

export function aprView(row: CreditAprRow): AprView {
  return {
    account_id: row.account_id,
    item_id: row.item_id,
    refreshed_at: row.refreshed_at,
    apr_type: row.apr_type,
    apr_percentage: row.apr_percentage,
    balance_subject_to_apr: centsToDollarsOrNull(row.balance_subject_to_apr_cents),
    interest_charge_amount: centsToDollarsOrNull(row.interest_charge_amount_cents),
  };
}

export function liabilitiesResultView(result: LiabilitiesQueryResult): {
  mortgages: MortgageView[];
  credit: CreditView[];
  aprs: AprView[];
  meta: QueryMeta;
} {
  const byId = new Map(result.accounts.map(a => [a.id, a]));
  return {
    mortgages: result.mortgages.map(r => mortgageView(r, byId.get(r.account_id))),
    credit: result.credit.map(r => creditView(r, byId.get(r.account_id))),
    aprs: result.aprs.map(aprView),
    meta: result.meta,
  };
}
