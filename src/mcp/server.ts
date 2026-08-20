import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { LedgerConfig } from '../core/config.js';
import type { Db } from '../core/db.js';
import {
  authStatus,
  listAccounts,
  listCategories,
  listTransactions,
  spendingSummary,
} from '../core/queries.js';
import { isReauthRequired, type LedgerPlaidApi } from '../core/plaid-client.js';
import { listRecurring, refreshRecurring } from '../core/recurring.js';
import { listLiabilities, refreshLiabilities } from '../core/liabilities.js';
import { syncAll } from '../core/sync.js';
// Money is stored as integer cents. Every tool result goes through a view so the
// model always sees decimal dollars — the same views the CLI's --json output uses.
import {
  accountsResultView,
  liabilitiesResultView,
  recurringResultView,
  spendingResultView,
  transactionsResultView,
} from '../core/views.js';

interface Deps {
  db: Db;
  api: LedgerPlaidApi;
  cfg: LedgerConfig;
}

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

const REAUTH_GUIDANCE =
  'Plaid rejected the stored access token (ITEM_LOGIN_REQUIRED). Ask the user to run ' +
  '`ledger auth repair <item_id>` in a terminal — it re-authenticates the existing bank ' +
  'connection. Do not suggest `ledger auth`, which would create a duplicate connection and ' +
  'consume another slot against the 10-Item limit.';

function ok(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function err(error: unknown): ToolResult {
  const message = isReauthRequired(error)
    ? REAUTH_GUIDANCE
    : error instanceof Error
      ? error.message
      : String(error);
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

export function buildMcpServer(deps: Deps): McpServer {
  const server = new McpServer({ name: 'ledger-local', version: '0.1.0' });

  server.registerTool(
    'list_accounts',
    {
      description:
        'List all linked bank accounts with balances from the local cache. ' +
        'Result meta.stale=true means data is >24h old — consider calling sync first. ' +
        'available_balance and current_balance may be null when the institution does not report them. ' +
        'SIGN: for depository accounts a positive current_balance is money you have. For loan and ' +
        'credit accounts a positive current_balance is money OWED — subtract it from net worth, ' +
        'never add it. Without this, a $300k mortgage looks like an asset. limit is the credit ' +
        'limit when the institution reports one, otherwise null.',
      inputSchema: {},
    },
    async () => {
      try {
        return ok(accountsResultView(listAccounts(deps.db)));
      } catch (error) {
        return err(error);
      }
    },
  );

  server.registerTool(
    'list_transactions',
    {
      description:
        'Query cached transactions. ' +
        'CRITICAL SIGN CONVENTION: amounts use Plaid\'s convention, which is the OPPOSITE of a ' +
        'bank statement. A POSITIVE amount means money LEFT the account (a purchase, a payment, ' +
        'spending). A NEGATIVE amount means money ENTERED the account (a paycheck, a refund, a ' +
        'deposit). Do not assume the usual statement convention: reporting a negative amount as ' +
        'spending would be wrong. To total spending, sum only positive amounts; to total income, ' +
        'sum negative amounts and negate the result. Prefer the spending_summary tool for totals, ' +
        'which handles this for you. ' +
        'Dates accept yyyy-mm-dd or a relative keyword: today, yesterday, this-month, last-month, ' +
        'end-of-last-month, this-year, or <N>-days-ago (e.g. 30-days-ago) — an invalid date throws ' +
        'rather than silently returning nothing. category matches Plaid\'s primary personal-finance ' +
        'category case-insensitively (e.g. food_and_drink matches FOOD_AND_DRINK); use ' +
        '\'UNCATEGORIZED\' for transactions with no category. An unknown category throws, listing ' +
        'the valid values — call list_categories first if unsure what exists. Returns the total ' +
        'match count alongside the paginated rows. ' +
        'Rows carry category_confidence (VERY_HIGH to UNKNOWN, or null) — treat a LOW or ' +
        'UNKNOWN category as a guess rather than a fact. authorized_date is when the ' +
        'purchase happened and date is when it posted; use authorized_date when it is ' +
        'present and the question is about a specific day. counterparty_type of ' +
        '\'payment_app\' means counterparty is Venmo, Cash App, or similar — the app, not ' +
        'whoever was actually paid.',
      inputSchema: {
        accountId: z.string().optional(),
        from: z.string().optional().describe('inclusive start date: yyyy-mm-dd or a relative keyword'),
        to: z.string().optional().describe('inclusive end date: yyyy-mm-dd or a relative keyword'),
        category: z
          .string()
          .optional()
          .describe(
            "Plaid primary category, case-insensitive, e.g. FOOD_AND_DRINK or GENERAL_MERCHANDISE. " +
              "'UNCATEGORIZED' matches transactions with no category. See list_categories for valid values.",
          ),
        search: z.string().optional().describe('substring match on description/merchant'),
        status: z.enum(['posted', 'pending']).optional(),
        limit: z.number().int().positive().max(1000).optional().describe('default 100'),
        offset: z.number().int().nonnegative().optional(),
        verbose: z
          .boolean()
          .optional()
          .describe(
            'return every stored field instead of the default subset — raw bank memo, ' +
              'full location, payment_meta, merchant logo and website, and the complete ' +
              'counterparties chain. Costs substantially more context per row; ask for it ' +
              'when a specific question needs those fields, not by default.',
          ),
      },
    },
    async args => {
      try {
        return ok(transactionsResultView(listTransactions(deps.db, args), { verbose: args.verbose }));
      } catch (error) {
        return err(error);
      }
    },
  );

  server.registerTool(
    'list_categories',
    {
      description:
        'List every category value present in the local cache, with transaction counts. ' +
        'Call this before filtering list_transactions or list_transactions fails with an ' +
        '"unknown category" error — Plaid ships no fixed category list, so this local cache is ' +
        'the only source of truth for what values are valid right now.',
      inputSchema: {},
    },
    async () => {
      try {
        return ok(listCategories(deps.db));
      } catch (error) {
        return err(error);
      }
    },
  );

  server.registerTool(
    'spending_summary',
    {
      description:
        'Aggregate spending over a date range, grouped by category, merchant, month, or account. ' +
        'Totals are POSITIVE dollar amounts in every case, so no sign reasoning is needed here. ' +
        'By default only real spending is counted: pending transactions and money coming in are ' +
        'both excluded. Set includeInflows to also count deposits and refunds, and includePending ' +
        'to count not-yet-settled transactions. ' +
        'from/to accept yyyy-mm-dd or a relative keyword: today, yesterday, this-month, last-month, ' +
        'end-of-last-month, this-year, or <N>-days-ago (e.g. 30-days-ago) — an invalid date or an ' +
        'inverted range (from after to) throws rather than silently returning an empty result. ' +
        'Grouping by merchant collapses spelling variants of the same merchant using ' +
        'Plaid\'s stable entity id, so "Amazon" and "AMZN Mktp US*2K4" total as one row. ' +
        'Grouping by payment_channel splits online, in store, and other.',
      inputSchema: {
        from: z.string().describe('inclusive start date: yyyy-mm-dd or a relative keyword'),
        to: z.string().describe('inclusive end date: yyyy-mm-dd or a relative keyword'),
        groupBy: z.enum(['category', 'merchant', 'month', 'account', 'payment_channel']),
        accountId: z.string().optional(),
        includePending: z.boolean().optional(),
        includeInflows: z.boolean().optional(),
      },
    },
    async args => {
      try {
        return ok(spendingResultView(spendingSummary(deps.db, args)));
      } catch (error) {
        return err(error);
      }
    },
  );

  server.registerTool(
    'list_recurring',
    {
      description:
        'List recurring bills, subscriptions, and income streams that Plaid detected — the ' +
        'right tool for "what am I subscribed to", "what bills are due", "what is my fixed ' +
        'monthly cost", and "did a subscription get more expensive". These are Plaid\'s ' +
        'detections, not something derivable from list_transactions. ' +
        'direction is "outflow" for money leaving (bills, subscriptions) and "inflow" for ' +
        'money arriving (paychecks). average_amount and last_amount are dollars and follow ' +
        'the same sign convention as list_transactions: POSITIVE means money LEFT the ' +
        'account, so outflow streams are positive and inflow streams are negative. Report ' +
        'magnitudes to the user and use direction to say which way the money went. ' +
        'status is MATURE (established), EARLY_DETECTION (seen too few times to be certain — ' +
        'say so rather than stating it as fact), TOMBSTONED (it stopped arriving, i.e. the ' +
        'subscription appears to have ended), or UNKNOWN. is_active is a boolean. ' +
        'predicted_next_date is null when Plaid cannot predict the next occurrence — do not ' +
        'infer one from frequency in that case. ' +
        'Streams come from the local cache. meta.stale=true means they are >24h old — call ' +
        'refresh_recurring, then call this again. If nothing is returned at all, they have ' +
        'never been fetched; refresh_recurring is also the fix for that.',
      inputSchema: {
        direction: z.enum(['inflow', 'outflow']).optional(),
        activeOnly: z
          .boolean()
          .optional()
          .describe('exclude streams Plaid has marked as ended (TOMBSTONED)'),
        frequency: z
          .enum(['WEEKLY', 'BIWEEKLY', 'SEMI_MONTHLY', 'MONTHLY', 'ANNUALLY', 'UNKNOWN'])
          .optional(),
      },
    },
    async args => {
      try {
        return ok(recurringResultView(listRecurring(deps.db, args)));
      } catch (error) {
        return err(error);
      }
    },
  );

  server.registerTool(
    'refresh_recurring',
    {
      description:
        'Refetch recurring streams from the banks via the Plaid API. Call when ' +
        'list_recurring reports meta.stale=true or returns nothing at all. Takes ~5-30 ' +
        'seconds per bank. ' +
        'Each refresh REPLACES every stream for a bank — Plaid returns a full snapshot ' +
        'with no cursor, so a stream that disappears has ended rather than been lost. ' +
        'A per-bank failure does not discard that bank\'s existing streams. ' +
        'If a result carries needsConsent, Plaid refused the product for that bank. Report ' +
        'the error text verbatim — it explains that this is a dashboard setting, not ' +
        'something the user can grant from a terminal. Do not retry and do not suggest ' +
        '`ledger auth consent`, which cannot grant this product.',
      inputSchema: {
        itemId: z.string().optional().describe('refresh only this institution'),
      },
    },
    async args => {
      try {
        const results = await refreshRecurring(deps.db, deps.api, { itemId: args.itemId });
        if (results.some(r => r.needsReauth)) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: REAUTH_GUIDANCE, results }) }],
            isError: true,
          };
        }
        return ok({ results });
      } catch (error) {
        return err(error);
      }
    },
  );

  server.registerTool(
    'list_liabilities',
    {
      description:
        'List mortgages and credit cards from the local liabilities cache — the right tool ' +
        'for rate, term, escrow, next payment, remaining principal, APR, and due date. These ' +
        'are Plaid Liabilities, not something derivable from list_transactions. ' +
        'Mortgage outstanding_principal is JOINED from the account balance in the same ' +
        '/liabilities/get payload; it is not in Plaid\'s mortgage object. If it is null, say ' +
        'so — never derive one from origination_principal_amount. ' +
        'Every *_percentage field is a percentage, not money: 6.125 means 6.125%. ' +
        'Never report origination_principal_amount minus outstanding_principal as "amount ' +
        'paid" — that is principal reduction only and excludes interest, which on a mortgage ' +
        'is most of what was paid. ' +
        'escrow_balance is a balance held on the borrower\'s behalf, never a payment amount; ' +
        'never add it to next_monthly_payment and never subtract it from principal. ' +
        'next_monthly_payment is the servicer\'s stated next payment and is not guaranteed to ' +
        'include escrow, taxes, or insurance — not "total housing cost." ' +
        'ytd_interest_paid and ytd_principal_paid are calendar-year-to-date as of refreshed_at, ' +
        'reset each January, not lifetime totals. Lifetime interest paid is not available from ' +
        'Plaid at all. ' +
        'loan_term and loan_type_description are unenumerated free text from the servicer ' +
        '("30 year", "360 months") — display only, never parsed. maturity_date is the ' +
        'machine-readable payoff date. ' +
        'kind filters to mortgage or credit. accountId filters to one account. ' +
        'meta.stale=true means the Item-level snapshot is >24h old — call refresh_liabilities, ' +
        'then call this again. Plaid re-reads liabilities about once a day and it cannot be ' +
        'forced, so a stale figure stays stale until tomorrow — say so rather than retrying. ' +
        'If nothing is returned at all, they have never been fetched; refresh_liabilities is ' +
        'also the fix for that. HELOC and auto loans are not covered by Plaid Liabilities.',
      inputSchema: {
        kind: z.enum(['mortgage', 'credit']).optional(),
        accountId: z.string().optional(),
      },
    },
    async args => {
      try {
        return ok(liabilitiesResultView(listLiabilities(deps.db, args)));
      } catch (error) {
        return err(error);
      }
    },
  );

  server.registerTool(
    'refresh_liabilities',
    {
      description:
        'Refetch mortgage and credit-card liabilities from the banks via the Plaid API. Call ' +
        'when list_liabilities reports meta.stale=true or returns nothing at all. Takes ' +
        '~5-30 seconds per bank. ' +
        'Each refresh REPLACES every liability for a bank — Plaid returns a full snapshot ' +
        'with no cursor, so a card that disappears has been closed rather than lost. ' +
        'There is no /liabilities/refresh; Plaid re-reads on its own daily schedule and it ' +
        'cannot be forced, so a stale figure stays stale until tomorrow. ' +
        'NO_LIABILITY_ACCOUNTS returns ok: true and is normal for checking-only banks — not ' +
        'an error, do not retry, do not mention unless asked about that bank. It still ' +
        'writes an empty snapshot so a closed card does not linger. ' +
        'If a result carries needsConsent, run `ledger auth consent <item_id>` — unlike ' +
        'recurring transactions, Liabilities IS grantable per Item through Link update mode. ' +
        'If a result carries unsupported, the institution cannot serve the product; consent ' +
        'will not help and there is nothing to retry. ' +
        'A per-bank failure does not discard that bank\'s existing liabilities.',
      inputSchema: {
        itemId: z.string().optional().describe('refresh only this institution'),
      },
    },
    async args => {
      try {
        const results = await refreshLiabilities(deps.db, deps.api, { itemId: args.itemId });
        if (results.some(r => r.needsReauth)) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: REAUTH_GUIDANCE, results }) }],
            isError: true,
          };
        }
        return ok({ results });
      } catch (error) {
        return err(error);
      }
    },
  );

  server.registerTool(
    'sync',
    {
      description:
        'Refresh the local cache from the banks via the Plaid API. Call when results show ' +
        'stale: true and current data matters. Takes ~5-30 seconds. Returns per-account ' +
        'inserted/updated/removed counts. ' +
        'Note on accountId: Plaid refreshes a whole bank connection at once, so passing ' +
        'accountId still refreshes every account at that institution — it only narrows what ' +
        'is reported back. ' +
        'On force: WITHOUT it, this returns whatever Plaid last pulled from the bank, which ' +
        'it does on its own schedule 1-4 times a day — so a transaction from the last few ' +
        'hours may legitimately be missing. WITH it, Plaid is asked to pull from the bank ' +
        'right now. Use force ONLY when the answer depends on the last few hours (for ' +
        'example "did my paycheck arrive today", "did that payment go through"), never as a ' +
        'routine precaution: it may be billed per call. Even with force the bank-side pull ' +
        'is asynchronous, so a very recent transaction can still take another sync to appear.',
      inputSchema: {
        accountId: z
          .string()
          .optional()
          .describe('report only this account (its whole institution is still refreshed)'),
        force: z
          .boolean()
          .optional()
          .describe(
            'ask Plaid to pull from the bank now rather than using its last scheduled pull. ' +
              'May be billed per call — only for questions about the last few hours.',
          ),
      },
    },
    async args => {
      try {
        const results = await syncAll(deps.db, deps.api, {
          accountId: args.accountId,
          force: args.force,
        });
        if (results.some(r => r.needsReauth)) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: REAUTH_GUIDANCE, results }) }],
            isError: true,
          };
        }
        return ok({ results });
      } catch (error) {
        return err(error);
      }
    },
  );

  server.registerTool(
    'auth_status',
    {
      description:
        'Show linked institutions, their Plaid item ids, account counts, and whether each has ' +
        'completed a sync. If no items exist, ask the user to run `ledger auth` in a terminal — ' +
        'linking a bank needs a human at a browser and cannot be done from here. Use the item ' +
        'ids reported here when telling the user which connection to repair.',
      inputSchema: {},
    },
    async () => {
      try {
        return ok(authStatus(deps.db, deps.cfg));
      } catch (error) {
        return err(error);
      }
    },
  );

  return server;
}
