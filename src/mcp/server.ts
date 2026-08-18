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
import { syncAll } from '../core/sync.js';
// Money is stored as integer cents. Every tool result goes through a view so the
// model always sees decimal dollars — the same views the CLI's --json output uses.
import {
  accountsResultView,
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
        'available_balance and current_balance may be null when the institution does not report them.',
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
    'sync',
    {
      description:
        'Refresh the local cache from the banks via the Plaid API. Call when results show ' +
        'stale: true and current data matters. Takes ~5-30 seconds. Returns per-account ' +
        'inserted/updated/removed counts. ' +
        'Note on accountId: Plaid refreshes a whole bank connection at once, so passing ' +
        'accountId still refreshes every account at that institution — it only narrows what ' +
        'is reported back.',
      inputSchema: {
        accountId: z
          .string()
          .optional()
          .describe('report only this account (its whole institution is still refreshed)'),
      },
    },
    async args => {
      try {
        const results = await syncAll(deps.db, deps.api, { accountId: args.accountId });
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
