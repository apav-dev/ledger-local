#!/usr/bin/env node
import { exec } from 'node:child_process';
import { Command } from 'commander';
import { startAuthServer } from '../auth/server.js';
import { ConfigError, certsPresent, loadConfig, setupInstructions, type TellerConfig } from '../core/config.js';
import { openDb, upsertEnrollment, type Db } from '../core/db.js';
import { authStatus, listAccounts, listTransactions, spendingSummary, type SpendingGroupBy } from '../core/queries.js';
import { syncAll, type AccountSyncResult } from '../core/sync.js';
import { TellerApiError, clientFromConfig } from '../core/teller-client.js';
import { formatTable, money } from './format.js';

const EXIT_GENERAL = 1;
const EXIT_CONFIG = 2;
const EXIT_REAUTH = 3;

interface Ctx {
  cfg: TellerConfig;
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

function handleError(error: unknown, json: boolean): never {
  if (error instanceof ConfigError) {
    process.stderr.write(`${error.message}\n`);
    process.exit(EXIT_CONFIG);
  }
  if (error instanceof TellerApiError && error.status === 401) {
    const msg = 'Teller rejected the access token (401). Re-run `teller auth` for that institution.';
    process.stderr.write(json ? JSON.stringify({ error: msg, needs_reauth: true }) + '\n' : msg + '\n');
    process.exit(EXIT_REAUTH);
  }
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(EXIT_GENERAL);
}

function printSyncResults(results: AccountSyncResult[], json: boolean): void {
  if (json) {
    process.stdout.write(JSON.stringify(results, null, 2) + '\n');
    return;
  }
  process.stdout.write(
    formatTable(
      results.map(r => ({
        account: r.accountName,
        ok: r.ok ? 'yes' : 'NO',
        inserted: r.inserted,
        updated: r.updated,
        error: r.error ?? '',
      })),
    ) + '\n',
  );
  if (results.some(r => !r.ok)) process.exitCode = EXIT_GENERAL;
}

const program = new Command()
  .name('teller')
  .description('Local Teller financial data: sync to SQLite, query from anywhere')
  .option('--json', 'machine-readable JSON output');

const auth = program.command('auth').description('link a bank via Teller Connect');

auth.action(
  withCtx(program, async ({ cfg, db, json }) => {
    if (cfg.environment !== 'sandbox' && !certsPresent(cfg)) {
      throw new ConfigError(
        `Certificates missing for ${cfg.environment}.\n${setupInstructions(cfg.configDir)}`,
      );
    }
    const server = await startAuthServer({
      applicationId: cfg.applicationId,
      environment: cfg.environment,
    });
    process.stdout.write(`Opening ${server.url} — complete bank login in the browser.\n`);
    exec(`open ${server.url}`);
    const enrollment = await server.result;
    upsertEnrollment(db, {
      id: enrollment.enrollmentId,
      access_token: enrollment.accessToken,
      institution: enrollment.institutionName,
      created_at: Date.now(),
    });
    process.stdout.write(`Linked ${enrollment.institutionName}. Running initial sync…\n`);
    const results = await syncAll(db, clientFromConfig(cfg));
    printSyncResults(results, json);
  }),
);

auth
  .command('status')
  .description('show enrollments and cert status')
  .action(
    withCtx(program, ({ cfg, db, json }) => {
      const status = authStatus(db, cfg);
      process.stdout.write(
        json
          ? JSON.stringify(status, null, 2) + '\n'
          : `environment: ${status.environment}\ncerts: ${status.certsPresent ? 'present' : 'MISSING'}\n` +
              formatTable(status.enrollments) + '\n',
      );
    }),
  );

program
  .command('sync')
  .description('refresh accounts, balances, and transactions from Teller')
  .option('--account <id>', 'sync a single account')
  .action(
    withCtx(program, async ({ cfg, db, json }, opts: { account?: string }) => {
      const results = await syncAll(db, clientFromConfig(cfg), { accountId: opts.account });
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
            last4: a.last_four,
            available: money(a.available_balance),
          })),
        ) + `\n${meta.stale ? 'STALE — run `teller sync`' : 'fresh'}\n`,
      );
    }),
  );

program
  .command('transactions')
  .description('query transactions (from local db)')
  .option('--account <id>')
  .option('--from <date>')
  .option('--to <date>')
  .option('--category <name>')
  .option('--search <text>')
  .option('--limit <n>', 'default 100')
  .action(
    withCtx(
      program,
      ({ db, json }, opts: { account?: string; from?: string; to?: string; category?: string; search?: string; limit?: string }) => {
        const result = listTransactions(db, {
          ...(opts.account !== undefined && { accountId: opts.account }),
          ...(opts.from !== undefined && { from: opts.from }),
          ...(opts.to !== undefined && { to: opts.to }),
          ...(opts.category !== undefined && { category: opts.category }),
          ...(opts.search !== undefined && { search: opts.search }),
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
              category: t.category ?? '',
              status: t.status,
            })),
          ) + `\n${result.transactions.length} of ${result.total} shown\n`,
        );
      },
    ),
  );

program
  .command('spending')
  .description('spending rollup (from local db)')
  .requiredOption('--from <date>')
  .requiredOption('--to <date>')
  .option('--by <group>', 'category|merchant|month|account', 'category')
  .option('--account <id>')
  .action(
    withCtx(
      program,
      ({ db, json }, opts: { from: string; to: string; by: string; account?: string }) => {
        const groupBy = opts.by as SpendingGroupBy;
        if (!['category', 'merchant', 'month', 'account'].includes(groupBy)) {
          throw new Error(`--by must be category|merchant|month|account, got "${opts.by}"`);
        }
        const result = spendingSummary(db, {
          from: opts.from,
          to: opts.to,
          groupBy,
          ...(opts.account !== undefined && { accountId: opts.account }),
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
