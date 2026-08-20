import type {
  APR,
  CreditCardLiability,
  LiabilitiesGetResponse,
  MortgageLiability,
} from 'plaid';
import {
  lastLiabilitiesRefreshAt,
  listAccountIdsForItem,
  listAccountRows,
  listCreditAprRows,
  listCreditRows,
  listItems,
  listMortgageRows,
  replaceLiabilities,
  upsertAccount,
  type AccountRow,
  type CreditAprRow,
  type CreditLiabilityRow,
  type Db,
  type LiabilitySnapshot,
  type MortgageLiabilityRow,
} from './db.js';
import { toCentsOrNull } from './money.js';
import {
  isConsentRequired,
  isNoLiabilityAccounts,
  isProductUnsupported,
  isReauthRequired,
  type LedgerPlaidApi,
} from './plaid-client.js';
import type { QueryMeta } from './queries.js';
import { toAccountUpsert } from './sync.js';

const STALE_MS = 24 * 3600 * 1000;

const CONSENT_HINT =
  'Plaid says this bank has not consented to Liabilities. Unlike recurring transactions, ' +
  'this one IS grantable per Item: run `ledger auth consent <item_id>`, which uses Link ' +
  'update mode — it keeps the connection, the cursor, and the Item slot.';
const UNSUPPORTED_HINT =
  'This institution does not support Liabilities. Consent will not help and there is ' +
  'nothing to retry — Plaid coverage varies by bank.';

/**
 * Semantics a caller cannot infer from the field names, each one a way to state
 * a confidently wrong number.
 *
 * Emitted verbatim in `ledger liabilities --json` and shown by
 * `ledger liabilities --help`. The MCP `list_liabilities` description carries the
 * same warnings in prose — an agent driving the CLI never sees a tool
 * description, and that is the only surface some callers have. Change both
 * together.
 */
export const LIABILITY_CAVEATS: readonly string[] = [
  'Amounts are dollars. Every *_percentage field is a percentage, not money: 6.125 means 6.125%.',
  'outstanding_principal is joined from the account balance, not from Plaid\'s mortgage ' +
    'payload. Null means the institution reported none — do not derive it from ' +
    'origination_principal_amount.',
  'Do NOT report origination_principal_amount minus outstanding_principal as "amount paid". ' +
    'That is principal reduction only and excludes interest, which on a mortgage is most of ' +
    'what has actually been paid. Plaid does not report total paid and it cannot be derived ' +
    'from this data.',
  'escrow_balance is a balance held on the borrower\'s behalf, never a payment amount. Never ' +
    'add it to next_monthly_payment and never subtract it from principal.',
  'next_monthly_payment is the servicer\'s stated next payment and is not guaranteed to ' +
    'include escrow, taxes, or insurance. It is not "total housing cost".',
  'ytd_interest_paid and ytd_principal_paid are calendar-year-to-date as of refreshed_at and ' +
    'reset every January. They are not lifetime totals.',
  'loan_term and loan_type_description are unenumerated free text from the servicer ' +
    '("30 year", "360 months") — display only, never parsed. maturity_date is the ' +
    'machine-readable payoff date.',
  'On loan and credit accounts a positive balance is money OWED — subtract it from net worth, ' +
    'never add it.',
  'Plaid re-reads liabilities about once a day and it cannot be forced, so a stale figure ' +
    'stays stale until tomorrow. Say so rather than retrying.',
];

/** SQLite has no boolean. Null stays null so "unreported" does not become "no". */
function sqliteBool(value: boolean | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return value ? 1 : 0;
}

function toMortgageRow(
  m: MortgageLiability,
  itemId: string,
  refreshedAt: number,
): MortgageLiabilityRow {
  return {
    account_id: m.account_id,
    item_id: itemId,
    refreshed_at: refreshedAt,
    // Optional-chain: Plaid's generated types assert these nested objects are
    // present, but a thin servicer omits them on the wire.
    interest_rate_percentage: m.interest_rate?.percentage ?? null,
    interest_rate_type: m.interest_rate?.type ?? null,
    escrow_balance_cents: toCentsOrNull(m.escrow_balance),
    current_late_fee_cents: toCentsOrNull(m.current_late_fee),
    has_pmi: sqliteBool(m.has_pmi),
    has_prepayment_penalty: sqliteBool(m.has_prepayment_penalty),
    last_payment_amount_cents: toCentsOrNull(m.last_payment_amount),
    last_payment_date: m.last_payment_date ?? null,
    loan_type_description: m.loan_type_description ?? null,
    loan_term: m.loan_term ?? null,
    maturity_date: m.maturity_date ?? null,
    next_monthly_payment_cents: toCentsOrNull(m.next_monthly_payment),
    next_payment_due_date: m.next_payment_due_date ?? null,
    origination_date: m.origination_date ?? null,
    origination_principal_amount_cents: toCentsOrNull(m.origination_principal_amount),
    past_due_amount_cents: toCentsOrNull(m.past_due_amount),
    property_street: m.property_address?.street ?? null,
    property_city: m.property_address?.city ?? null,
    property_region: m.property_address?.region ?? null,
    property_postal_code: m.property_address?.postal_code ?? null,
    property_country: m.property_address?.country ?? null,
    ytd_interest_paid_cents: toCentsOrNull(m.ytd_interest_paid),
    ytd_principal_paid_cents: toCentsOrNull(m.ytd_principal_paid),
  };
}

function purchaseAprPercentage(aprs: readonly APR[]): number | null {
  const found = aprs.find(a => String(a.apr_type) === 'purchase_apr');
  return found === undefined ? null : found.apr_percentage;
}

function toCreditRow(
  c: CreditCardLiability,
  accountId: string,
  itemId: string,
  refreshedAt: number,
): CreditLiabilityRow {
  return {
    account_id: accountId,
    item_id: itemId,
    refreshed_at: refreshedAt,
    is_overdue: sqliteBool(c.is_overdue),
    last_payment_amount_cents: toCentsOrNull(c.last_payment_amount),
    last_payment_date: c.last_payment_date ?? null,
    last_statement_issue_date: c.last_statement_issue_date ?? null,
    last_statement_balance_cents: toCentsOrNull(c.last_statement_balance),
    minimum_payment_amount_cents: toCentsOrNull(c.minimum_payment_amount),
    next_payment_due_date: c.next_payment_due_date ?? null,
    purchase_apr_percentage: purchaseAprPercentage(c.aprs),
  };
}

function toAprRow(
  a: APR,
  accountId: string,
  itemId: string,
  refreshedAt: number,
): CreditAprRow {
  return {
    account_id: accountId,
    item_id: itemId,
    refreshed_at: refreshedAt,
    apr_type: String(a.apr_type),
    // Percentages are percentages. Never through toCents.
    apr_percentage: a.apr_percentage,
    balance_subject_to_apr_cents: toCentsOrNull(a.balance_subject_to_apr),
    interest_charge_amount_cents: toCentsOrNull(a.interest_charge_amount),
  };
}

export function toLiabilityRows(
  response: LiabilitiesGetResponse,
  itemId: string,
  refreshedAt: number,
  knownAccountIds: ReadonlySet<string>,
): { snapshot: LiabilitySnapshot; dropped: number } {
  let dropped = 0;
  const mortgage: MortgageLiabilityRow[] = [];
  const credit: CreditLiabilityRow[] = [];
  const aprs: CreditAprRow[] = [];

  for (const m of response.liabilities.mortgage ?? []) {
    if (!knownAccountIds.has(m.account_id)) {
      dropped += 1;
      continue;
    }
    mortgage.push(toMortgageRow(m, itemId, refreshedAt));
  }

  for (const c of response.liabilities.credit ?? []) {
    if (c.account_id === null || !knownAccountIds.has(c.account_id)) {
      dropped += 1;
      continue;
    }
    credit.push(toCreditRow(c, c.account_id, itemId, refreshedAt));
    for (const a of c.aprs) aprs.push(toAprRow(a, c.account_id, itemId, refreshedAt));
  }

  return { snapshot: { mortgage, credit, aprs }, dropped };
}

export interface LiabilitiesRefreshResult {
  itemId: string;
  institution: string;
  ok: boolean;
  mortgages: number;
  credit: number;
  removed: number;
  dropped: number;
  /** Plaid answered NO_LIABILITY_ACCOUNTS. An outcome, not a failure. */
  noLiabilityAccounts?: boolean | undefined;
  error?: string;
  needsReauth?: boolean | undefined;
  needsConsent?: boolean | undefined;
  unsupported?: boolean | undefined;
}

const EMPTY_SNAPSHOT: LiabilitySnapshot = { mortgage: [], credit: [], aprs: [] };

/**
 * Refetches liabilities for every Item, or one.
 *
 * Per-Item failures are collected rather than thrown: one bank that needs
 * re-authentication must not hide the mortgage of every other bank.
 */
export async function refreshLiabilities(
  db: Db,
  api: LedgerPlaidApi,
  opts: { itemId?: string | undefined; now?: (() => number) | undefined } = {},
): Promise<LiabilitiesRefreshResult[]> {
  const now = opts.now ?? Date.now;
  const items = listItems(db).filter(i => opts.itemId === undefined || i.id === opts.itemId);
  const results: LiabilitiesRefreshResult[] = [];

  for (const item of items) {
    try {
      const response = await api.getLiabilities(item.access_token);
      const refreshedAt = now();

      // Remaining principal lives on AccountBase, not MortgageLiability. Upsert
      // the same payload's accounts first so the rate and the balance cannot be
      // from different moments, and so a loan opened since the last sync is a
      // parent row rather than a foreign-key drop. Do not stamp last_synced_at:
      // these balances are Plaid's cached copy, not a forced live read.
      for (const account of response.accounts) {
        upsertAccount(db, toAccountUpsert(account, item.id, item.institution));
      }

      const known = new Set(listAccountIdsForItem(db, item.id));
      const { snapshot, dropped } = toLiabilityRows(response, item.id, refreshedAt, known);
      const removed = replaceLiabilities(db, item.id, snapshot, refreshedAt);
      results.push({
        itemId: item.id,
        institution: item.institution,
        ok: true,
        mortgages: snapshot.mortgage.length,
        credit: snapshot.credit.length,
        removed,
        dropped,
      });
    } catch (error) {
      if (isNoLiabilityAccounts(error)) {
        // A bank that closed its last card answers this way. Writing the empty
        // snapshot is what forgets the dead card; skipping the write would keep
        // it forever. This is success — it must not set a non-zero exit code.
        const removed = replaceLiabilities(db, item.id, EMPTY_SNAPSHOT, now());
        results.push({
          itemId: item.id,
          institution: item.institution,
          ok: true,
          mortgages: 0,
          credit: 0,
          removed,
          dropped: 0,
          noLiabilityAccounts: true,
        });
        continue;
      }

      // isProductUnsupported before isConsentRequired: the latter also matches
      // PRODUCTS_NOT_SUPPORTED, which for liabilities means the institution
      // cannot serve the product, not that consent is missing.
      const unsupported = isProductUnsupported(error);
      const consent = !unsupported && isConsentRequired(error);
      results.push({
        itemId: item.id,
        institution: item.institution,
        ok: false,
        mortgages: 0,
        credit: 0,
        removed: 0,
        dropped: 0,
        error: unsupported
          ? UNSUPPORTED_HINT
          : consent
            ? CONSENT_HINT
            : error instanceof Error
              ? error.message
              : String(error),
        needsReauth: isReauthRequired(error) ? true : undefined,
        needsConsent: consent ? true : undefined,
        unsupported: unsupported ? true : undefined,
      });
    }
  }

  return results;
}

export interface LiabilityFilters {
  kind?: 'mortgage' | 'credit' | undefined;
  accountId?: string | undefined;
}

export interface LiabilitiesQueryResult {
  mortgages: MortgageLiabilityRow[];
  credit: CreditLiabilityRow[];
  aprs: CreditAprRow[];
  /** Parent accounts so views can join remaining principal and credit limit. */
  accounts: AccountRow[];
  meta: QueryMeta;
}

/**
 * Reads stored liabilities. Staleness is the Item stamp, not MIN(refreshed_at)
 * over data rows — a refreshed bank with zero liabilities is fresh.
 */
export function listLiabilities(
  db: Db,
  f: LiabilityFilters = {},
  now: () => number = Date.now,
): LiabilitiesQueryResult {
  const accountId = f.accountId;
  const mortgages = listMortgageRows(db).filter(r => {
    if (f.kind === 'credit') return false;
    if (accountId !== undefined && r.account_id !== accountId) return false;
    return true;
  });
  const credit = listCreditRows(db).filter(r => {
    if (f.kind === 'mortgage') return false;
    if (accountId !== undefined && r.account_id !== accountId) return false;
    return true;
  });
  const aprs = listCreditAprRows(db).filter(r => {
    if (f.kind === 'mortgage') return false;
    if (accountId !== undefined && r.account_id !== accountId) return false;
    return true;
  });

  const wanted = new Set([
    ...mortgages.map(r => r.account_id),
    ...credit.map(r => r.account_id),
  ]);
  const accounts = listAccountRows(db).filter(a => wanted.has(a.id));

  const refreshedAt = lastLiabilitiesRefreshAt(db);
  const meta: QueryMeta =
    refreshedAt === null
      ? { last_synced_at: null, stale: true }
      : { last_synced_at: refreshedAt, stale: now() - refreshedAt > STALE_MS };

  return { mortgages, credit, aprs, accounts, meta };
}
