#!/usr/bin/env node
import { exec } from 'node:child_process';
import { Command } from 'commander';
import { linkNewItem, repairItem, LinkError } from '../auth/link.js';
import { ConfigError, loadConfig, type LedgerConfig } from '../core/config.js';
import { openDb, type Db } from '../core/db.js';
import {
  authStatus,
  listAccounts,
  listTransactions,
  spendingSummary,
  type SpendingGroupBy,
} from '../core/queries.js';
import { clientFromConfig, isReauthRequired } from '../core/plaid-client.js';
import { syncAll, type AccountSyncResult } from '../core/sync.js';
import { formatTable, money } from './format.js';

const EXIT_GENERAL = 1;
const EXIT_CONFIG = 2;
const EXIT_REAUTH = 3;

const REAUTH_HINT =
  'Plaid rejected a stored access token (ITEM_LOGIN_REQUIRED).\n' +
  'Run `ledger auth repair <item_id>` to re-authenticate that bank — see `ledger auth status`\n' +
  'for item ids. Do not run `ledger auth`, which would create a duplicate connection.';

interface Ctx {
  cfg: LedgerConfig;
  db: Db;
  json: boolean;
}

function withCtx(program: Command, run: (ctx: Ctx, ...args: never[]) => Promise<void> | void) {
  return async (...args: unknown[]) => {
    const json = Boolean(program.opts()['json']);
    try {
      const cfg = loadConfig();
      const db = openDb(cfg.dbPath);
      await run({ cfg, db, json }, ...(args as never[]));
    } catch (error) {
      handleError(error, json);
    }
  };
}

function fail(message: string, code: number, json: boolean, extra?: Record<string, unknown>): never {
  process.stderr.write(
    json ? JSON.stringify({ error: message, ...extra }) + '\n' : message + '\n',
  );
  process.exit(code);
}

function handleError(error: unknown, json: boolean): never {
  if (error instanceof ConfigError) fail(error.message, EXIT_CONFIG, json);
  // Keyed on Plaid's error_code, not an HTTP status: ITEM_LOGIN_REQUIRED
  // arrives as 400, so a status check would never fire.
  if (isReauthRequired(error)) fail(REAUTH_HINT, EXIT_REAUTH, json, { needs_reauth: true });
  if (error instanceof LinkError) fail(error.message, EXIT_GENERAL, json);
  fail(error instanceof Error ? error.message : String(error), EXIT_GENERAL, json);
}

function printSyncResults(results: AccountSyncResult[], json: boolean): void {
  const needsReauth = results.some(r => r.needsReauth);
  if (json) {
    process.stdout.write(
      JSON.stringify(needsReauth ? { results, needs_reauth: true } : results, null, 2) + '\n',
    );
  } else {
    process.stdout.write(
      formatTable(
        results.map(r => ({
          account: r.accountName,
          ok: r.ok ? 'yes' : 'NO',
          inserted: r.inserted,
          updated: r.updated,
          removed: r.removed,
          error: r.error ?? '',
        })),
      ) + '\n',
    );
  }
  if (needsReauth) {
    process.stderr.write(REAUTH_HINT + '\n');
    process.exitCode = EXIT_REAUTH;
  } else if (results.some(r => !r.ok)) {
    process.exitCode = EXIT_GENERAL;
  }
}

function openInBrowser(url: string): void {
  // Detached so a slow browser launch cannot hold the CLI open.
  exec(`open ${JSON.stringify(url)}`);
}

const program = new Command()
  .name('ledger')
  .description('Local Plaid financial data: sync to SQLite, query from anywhere')
  .option('--json', 'machine-readable JSON output');

const auth = program.command('auth').description('link a bank via Plaid Hosted Link');

auth.action(
  withCtx(program, async ({ db, cfg, json }) => {
    const api = clientFromConfig(cfg);
    const { itemId, institution } = await linkNewItem(db, api, {
      openUrl: openInBrowser,
      report: message => process.stdout.write(message + '\n'),
    });
    process.stdout.write(`Linked ${institution} (${itemId}). Running initial sync…\n`);
    printSyncResults(await syncAll(db, api, { itemId }), json);
  }),
);

auth
  .command('status')
  .description('show linked institutions and their sync state')
  .action(
    withCtx(program, ({ cfg, db, json }) => {
      const status = authStatus(db, cfg);
      if (json) {
        process.stdout.write(JSON.stringify(status, null, 2) + '\n');
        return;
      }
      process.stdout.write(
        `environment: ${status.environment}\n` +
          `items: ${status.items.length} of 10 (Plaid Trial plan limit)\n` +
          formatTable(
            status.items.map(i => ({
              item_id: i.id,
              institution: i.institution,
              accounts: i.accountCount,
              synced: i.synced ? 'yes' : 'never',
            })),
          ) +
          '\n',
      );
    }),
  );

auth
  .command('repair <itemId>')
  .description('re-authenticate an existing bank (Link update mode; does not create a duplicate)')
  .action(
    withCtx(program, async ({ db, cfg, json }, itemId: string) => {
      const api = clientFromConfig(cfg);
      const { institution } = await repairItem(db, api, itemId, {
        openUrl: openInBrowser,
        report: message => process.stdout.write(message + '\n'),
      });
      process.stdout.write(`Re-authenticated ${institution}. Syncing…\n`);
      printSyncResults(await syncAll(db, api, { itemId }), json);
    }),
  );

program
  .command('sync')
  .description('refresh accounts, balances, and transactions from Plaid')
  .option(
    '--account <id>',
    'report only this account (Plaid still refreshes its whole institution)',
  )
  .option('--item <id>', 'refresh only this institution')
  .action(
    withCtx(program, async ({ cfg, db, json }, opts: { account?: string; item?: string }) => {
      const results = await syncAll(db, clientFromConfig(cfg), {
        accountId: opts.account,
        itemId: opts.item,
      });
      printSyncResults(results, json);
    }),
  );

program
  .command('accounts')
  .description('list accounts with balances (from local db)')
  .action(
    withCtx(program, ({ db, json }) => {
      const { accounts, meta } = listAccounts(db);
      if (json) {
        process.stdout.write(JSON.stringify({ accounts, meta }, null, 2) + '\n');
        return;
      }
      process.stdout.write(
        formatTable(
          accounts.map(a => ({
            institution: a.institution,
            name: a.name,
            type: a.type,
            mask: a.mask ?? '',
            available: money(a.available_balance),
            current: money(a.current_balance),
          })),
        ) + `\n${meta.stale ? 'STALE — run `ledger sync`' : 'fresh'}\n`,
      );
    }),
  );

program
  .command('transactions')
  .description('query transactions (from local db; positive amounts are money out)')
  .option('--account <id>')
  .option('--from <date>')
  .option('--to <date>')
  .option('--category <name>', 'Plaid primary category, e.g. FOOD_AND_DRINK')
  .option('--search <text>')
  .option('--status <status>', 'posted|pending')
  .option('--limit <n>', 'default 100')
  .action(
    withCtx(
      program,
      (
        { db, json },
        opts: {
          account?: string;
          from?: string;
          to?: string;
          category?: string;
          search?: string;
          status?: string;
          limit?: string;
        },
      ) => {
        if (opts.status !== undefined && opts.status !== 'posted' && opts.status !== 'pending') {
          throw new Error(`--status must be posted|pending, got "${opts.status}"`);
        }
        const result = listTransactions(db, {
          ...(opts.account !== undefined && { accountId: opts.account }),
          ...(opts.from !== undefined && { from: opts.from }),
          ...(opts.to !== undefined && { to: opts.to }),
          ...(opts.category !== undefined && { category: opts.category }),
          ...(opts.search !== undefined && { search: opts.search }),
          ...(opts.status !== undefined && { status: opts.status as 'posted' | 'pending' }),
          ...(opts.limit !== undefined && { limit: Number(opts.limit) }),
        });
        if (json) {
          process.stdout.write(JSON.stringify(result, null, 2) + '\n');
          return;
        }
        process.stdout.write(
          formatTable(
            result.transactions.map(t => ({
              date: t.date,
              amount: money(t.amount),
              description: t.description,
              category: t.category_primary ?? '',
              status: t.status,
            })),
          ) + `\n${result.transactions.length} of ${result.total} shown (+ is money out)\n`,
        );
      },
    ),
  );

program
  .command('spending')
  .description('spending rollup (from local db; totals are positive dollars)')
  .requiredOption('--from <date>')
  .requiredOption('--to <date>')
  .option('--by <group>', 'category|merchant|month|account', 'category')
  .option('--account <id>')
  .option('--include-pending', 'count transactions that have not settled yet')
  .option('--include-inflows', 'also count money coming in')
  .action(
    withCtx(
      program,
      (
        { db, json },
        opts: {
          from: string;
          to: string;
          by: string;
          account?: string;
          includePending?: boolean;
          includeInflows?: boolean;
        },
      ) => {
        const groupBy = opts.by as SpendingGroupBy;
        if (!['category', 'merchant', 'month', 'account'].includes(groupBy)) {
          throw new Error(`--by must be category|merchant|month|account, got "${opts.by}"`);
        }
        const result = spendingSummary(db, {
          from: opts.from,
          to: opts.to,
          groupBy,
          ...(opts.account !== undefined && { accountId: opts.account }),
          ...(opts.includePending === true && { includePending: true }),
          ...(opts.includeInflows === true && { includeInflows: true }),
        });
        if (json) {
          process.stdout.write(JSON.stringify(result, null, 2) + '\n');
          return;
        }
        process.stdout.write(
          formatTable(
            result.groups.map(g => ({
              [groupBy]: g.key,
              total: money(g.total),
              count: g.count,
              share: `${(g.share * 100).toFixed(1)}%`,
            })),
          ) + `\ntotal: ${money(result.grandTotal)}\n`,
        );
      },
    ),
  );

program.parseAsync().catch(error => handleError(error, Boolean(program.opts()['json'])));
