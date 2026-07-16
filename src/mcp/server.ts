import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { TellerConfig } from '../core/config.js';
import type { Db } from '../core/db.js';
import {
  authStatus,
  listAccounts,
  listTransactions,
  spendingSummary,
} from '../core/queries.js';
import { syncAll } from '../core/sync.js';
import { TellerApiError } from '../core/teller-client.js';
import type { TellerApi } from '../core/types.js';

interface Deps {
  db: Db;
  api: TellerApi;
  cfg: TellerConfig;
}

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

function ok(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function err(error: unknown): ToolResult {
  let message = error instanceof Error ? error.message : String(error);
  if (error instanceof TellerApiError && error.status === 401) {
    message =
      'Teller rejected the stored access token (401). Ask the user to re-link the bank by running `teller auth` in a terminal.';
  }
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

export function buildMcpServer(deps: Deps): McpServer {
  const server = new McpServer({ name: 'teller-local', version: '0.1.0' });

  server.registerTool(
    'list_accounts',
    {
      description:
        'List all linked bank accounts with balances from the local cache. ' +
        'Result meta.stale=true means data is >24h old — consider calling sync first.',
      inputSchema: {},
    },
    async () => {
      try {
        return ok(listAccounts(deps.db));
      } catch (error) {
        return err(error);
      }
    },
  );

  server.registerTool(
    'list_transactions',
    {
      description:
        'Query cached transactions. Amounts follow bank sign convention: spending is negative, income positive. ' +
        'Dates are yyyy-mm-dd. Returns total match count alongside the (paginated) rows.',
      inputSchema: {
        accountId: z.string().optional(),
        from: z.string().optional().describe('inclusive start date yyyy-mm-dd'),
        to: z.string().optional().describe('inclusive end date yyyy-mm-dd'),
        category: z.string().optional(),
        search: z.string().optional().describe('substring match on description/merchant'),
        status: z.enum(['posted', 'pending']).optional(),
        limit: z.number().int().positive().max(1000).optional().describe('default 100'),
        offset: z.number().int().nonnegative().optional(),
      },
    },
    async (args) => {
      try {
        return ok(listTransactions(deps.db, args));
      } catch (error) {
        return err(error);
      }
    },
  );

  server.registerTool(
    'spending_summary',
    {
      description:
        'Aggregate spending (negative amounts only, pending excluded by default) over a date range, ' +
        'grouped by category, merchant, month, or account. Totals are positive dollar amounts.',
      inputSchema: {
        from: z.string().describe('inclusive start date yyyy-mm-dd'),
        to: z.string().describe('inclusive end date yyyy-mm-dd'),
        groupBy: z.enum(['category', 'merchant', 'month', 'account']),
        accountId: z.string().optional(),
        includePending: z.boolean().optional(),
        includeInflows: z.boolean().optional(),
      },
    },
    async (args) => {
      try {
        return ok(spendingSummary(deps.db, args));
      } catch (error) {
        return err(error);
      }
    },
  );

  server.registerTool(
    'sync',
    {
      description:
        'Refresh the local cache from the bank via the Teller API. Call when results show stale: true ' +
        'and current data matters. Takes ~5-30 seconds. Returns per-account insert/update counts.',
      inputSchema: {
        accountId: z.string().optional().describe('sync only this account'),
      },
    },
    async (args) => {
      try {
        const results = await syncAll(deps.db, deps.api, { accountId: args.accountId });
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
        'Show linked institutions, account counts, environment, and certificate status. ' +
        'If no enrollments exist, ask the user to run `teller auth` in a terminal — enrollment needs a human at a browser.',
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
