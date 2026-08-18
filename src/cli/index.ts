#!/usr/bin/env node
import { exec } from 'node:child_process';
import { Command } from 'commander';
import { linkNewItem, repairItem, upgradeConsent, LinkError } from '../auth/link.js';
import { ConfigError, loadConfig, type LedgerConfig } from '../core/config.js';
import { countTransactions, listAccountIdsForItem, openDb, type Db } from '../core/db.js';
import { removeLinkedItem } from '../core/items.js';
import {
  authStatus,
  listAccounts,
  listCategories,
  listTransactions,
  spendingSummary,
  type SpendingGroupBy,
} from '../core/queries.js';
import { PlaidClient, clientFromConfig, isReauthRequired } from '../core/plaid-client.js';
import { syncAll, type AccountSyncResult } from '../core/sync.js';
import { runInit } from './init.js';
import { createTtyPrompter, type Prompter } from './prompt.js';
// Money is stored as integer cents; --json emits dollars through these views, the
// same ones the MCP server uses, so the two frontends cannot disagree.
import { listRecurring, refreshRecurring, type RecurringRefreshResult } from '../core/recurring.js';
import {
  accountsResultView,
  recurringResultView,
  spendingResultView,
  transactionsResultView,
} from '../core/views.js';
import { formatTable, money } from './format.js';

const EXIT_GENERAL = 1;
const EXIT_CONFIG = 2;
const EXIT_REAUTH = 3;

/**
 * Shown when the sync that runs immediately after linking fails. Without it the
 * obvious next move is to re-run `auth`, which silently creates a SECOND Item
 * for the same bank and spends another of the ten slots.
 */
const POST_LINK_SYNC_HINT =
  'The bank is linked — that part succeeded. Plaid is most likely still assembling the\n' +
  'transaction history, which takes several minutes when two years are requested.\n' +
  'Run `ledger sync` in a few minutes to finish the backfill.\n' +
  'Do NOT run `ledger auth` again: that creates a second connection to the same bank\n' +
  'and consumes another of your 10 Item slots.';

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
      const db = openDb(cfg.dbPath, cfg.environment);
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

const RECURRING_PRODUCT_HINT =
  'Plaid refused recurring transactions for one or more banks.\n' +
  '`ledger auth consent` cannot fix this — Recurring Transactions is enabled per\n' +
  'client_id at Dashboard > Developers > Products, not per Item. Check it is enabled\n' +
  'there; also note that not every institution supports it.';

function printRecurringRefresh(results: RecurringRefreshResult[], json: boolean): void {
  if (json) {
    process.stdout.write(JSON.stringify(results, null, 2) + '\n');
  } else {
    process.stdout.write(
      formatTable(
        results.map(r => ({
          institution: r.institution,
          ok: r.ok ? 'yes' : 'NO',
          streams: r.streams,
          error: r.error ?? '',
        })),
      ) + '\n',
    );
  }
  if (results.some(r => r.needsConsent)) process.stderr.write(RECURRING_PRODUCT_HINT + '\n');
  if (results.some(r => r.needsReauth)) {
    process.stderr.write(REAUTH_HINT + '\n');
    process.exitCode = EXIT_REAUTH;
  } else if (results.some(r => !r.ok)) {
    process.exitCode = EXIT_GENERAL;
  }
}

/**
 * Opens a URL in the user's browser, best-effort.
 *
 * Detached so a slow browser launch cannot hold the CLI open, which also means
 * failures are invisible here — every caller prints the URL first, so a headless
 * or unsupported host degrades to "click this link" rather than to nothing.
 */
function openInBrowser(url: string): void {
  const opener =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'start ""'
        : 'xdg-open';
  exec(`${opener} ${JSON.stringify(url)}`);
}

const program = new Command()
  .name('ledger')
  .description('Local Plaid financial data: sync to SQLite, query from anywhere')
  .option('--json', 'machine-readable JSON output');

/** Shared by `ledger auth` and the optional link step at the end of `ledger init`. */
async function linkAndSync(cfg: LedgerConfig, db: Db, json: boolean): Promise<void> {
  const api = clientFromConfig(cfg);
  const { itemId, institution } = await linkNewItem(db, api, {
    openUrl: openInBrowser,
    report: message => process.stdout.write(message + '\n'),
  });
  process.stdout.write(`Linked ${institution} (${itemId}). Running initial sync…\n`);
  const results = await syncAll(db, api, { itemId });
  printSyncResults(results, json);

  // A reauth failure has its own hint; anything else right after linking is
  // almost always an unfinished historical pull.
  if (results.some(r => !r.ok && r.needsReauth !== true)) {
    process.stderr.write(POST_LINK_SYNC_HINT + '\n');
  }
}

program
  .command('init')
  .description('first-run setup: pick an environment, verify Plaid keys, write config.json')
  .option('--force', 'replace an existing config.json (invalidates linked banks)')
  .action(async (opts: { force?: boolean }) => {
    const json = Boolean(program.opts()['json']);
    // init is a conversation, not a query. Refuse --json rather than emit a
    // half-JSON stream interleaved with prompts.
    if (json) fail('`ledger init` is interactive and does not support --json.', EXIT_GENERAL, false);

    let prompter: Prompter | undefined;
    try {
      const result = await runInit({
        // Lazy: the TTY requirement should not mask a "config already exists"
        // failure, which runInit checks first.
        makePrompter: () =>
          (prompter = createTtyPrompter({
            nonTtyHint:
              'Run it directly in a shell, or write config.json by hand — see the Setup ' +
              'section of the README.',
          })),
        openUrl: openInBrowser,
        write: message => process.stdout.write(message + '\n'),
        // Built from the pasted values, not from a config file — nothing is on
        // disk yet at verification time.
        makeApi: input => new PlaidClient(input),
        force: opts.force ?? false,
      });

      if (!result.linkNow) {
        process.stdout.write('Next: `ledger auth` to link a bank.\n');
        return;
      }

      const cfg = loadConfig();
      const db = openDb(cfg.dbPath, cfg.environment);
      await linkAndSync(cfg, db, false);
    } catch (error) {
      handleError(error, false);
    } finally {
      prompter?.close();
    }
  });

const item = program.command('item').description('manage linked bank connections');

item
  .command('remove <itemId>')
  .description('permanently delete a bank connection, at Plaid and locally')
  .option('--yes', 'skip the confirmation prompt')
  .action(
    withCtx(program, async ({ cfg, db, json }, itemId: string, opts: { yes?: boolean }) => {
      const accountIds = listAccountIdsForItem(db, itemId);
      const txnCount = accountIds.reduce((sum, id) => sum + countTransactions(db, id), 0);

      if (opts.yes !== true) {
        // Irreversible on both sides: Plaid invalidates the access token, and
        // reconnecting means a brand-new Item with a new id and a fresh
        // historical pull. Never proceed without an explicit yes.
        const prompter = createTtyPrompter({
          nonTtyHint: 'Run it directly in a shell, or pass --yes to skip the confirmation.',
        });
        try {
          const confirmed = await prompter.confirm(
            `Permanently remove item ${itemId} (${accountIds.length} accounts, ` +
              `${txnCount} transactions)? This cannot be undone.`,
            false,
          );
          if (!confirmed) {
            process.stdout.write('Cancelled. Nothing was removed.\n');
            return;
          }
        } finally {
          prompter.close();
        }
      }

      const removed = await removeLinkedItem(db, clientFromConfig(cfg), itemId);
      if (json) {
        process.stdout.write(JSON.stringify(removed, null, 2) + '\n');
        return;
      }
      process.stdout.write(
        `Removed ${removed.institution} (${removed.itemId}): ` +
          `${removed.accounts} accounts, ${removed.transactions} transactions.\n` +
          (removed.alreadyGoneAtPlaid
            ? 'Plaid had already dropped this Item; only local rows were cleaned up.\n'
            : 'The Item slot is free again.\n'),
      );
    }),
  );

const auth = program.command('auth').description('link a bank via Plaid Hosted Link');

auth.action(withCtx(program, ({ db, cfg, json }) => linkAndSync(cfg, db, json)));

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
              consent: i.consentUpToDate ? 'current' : 'needs upgrade',
            })),
          ) +
          (status.items.some(i => !i.consentUpToDate)
            ? '\nSome banks predate the current product consent set. Run `ledger auth consent`\n' +
              'to grant it — update mode, so no duplicate Item and no slot consumed.\n'
            : '') +
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

auth
  .command('consent [itemId]')
  .description(
    'grant this build\'s full product consent to a linked bank (Link update mode; ' +
      'does not create a duplicate or cost an Item slot)',
  )
  .action(
    withCtx(program, async ({ db, cfg, json }, itemId?: string) => {
      const api = clientFromConfig(cfg);
      const status = authStatus(db, cfg);
      // With no id, upgrade only what needs it. Every upgrade is a browser
      // round-trip, so silently re-running current Items would be rude.
      const targets =
        itemId === undefined
          ? status.items.filter(i => !i.consentUpToDate).map(i => i.id)
          : [itemId];

      if (targets.length === 0) {
        const message = 'Every linked bank already has full consent. Nothing to do.';
        process.stdout.write(json ? JSON.stringify({ upgraded: [], message }) + '\n' : message + '\n');
        return;
      }

      const upgraded: Array<{ itemId: string; institution: string; consented: string[] }> = [];
      for (const target of targets) {
        process.stdout.write(`Upgrading consent for ${target}…\n`);
        upgraded.push(await upgradeConsent(db, api, target, {
          openUrl: openInBrowser,
          report: message => process.stdout.write(message + '\n'),
        }));
      }

      if (json) {
        process.stdout.write(JSON.stringify({ upgraded }, null, 2) + '\n');
        return;
      }
      for (const u of upgraded) {
        process.stdout.write(`Consent updated for ${u.institution} (${u.itemId}): ` +
          `${u.consented.join(', ')}\n`);
      }
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
  .option(
    '--force',
    'ask Plaid to pull from the bank now instead of using its last scheduled pull ' +
      '(may be billed per call)',
  )
  .action(
    withCtx(
      program,
      async ({ cfg, db, json }, opts: { account?: string; item?: string; force?: boolean }) => {
        const results = await syncAll(db, clientFromConfig(cfg), {
          accountId: opts.account,
          itemId: opts.item,
          force: opts.force,
        });
        printSyncResults(results, json);
        // Plaid's pull is asynchronous: the refresh is requested, not completed,
        // by the time the sync below it runs. Saying so beats a caller
        // concluding the bank had nothing new.
        if (opts.force === true && !json) {
          process.stdout.write(
            'Asked Plaid to pull from each bank. That pull is asynchronous, so anything it\n' +
              'finds may only appear on the next `ledger sync`.\n',
          );
        }
      },
    ),
  );

program
  .command('accounts')
  .description('list accounts with balances (from local db)')
  .action(
    withCtx(program, ({ db, json }) => {
      const result = listAccounts(db);
      if (json) {
        process.stdout.write(JSON.stringify(accountsResultView(result), null, 2) + '\n');
        return;
      }
      const { accounts, meta } = result;
      process.stdout.write(
        formatTable(
          accounts.map(a => ({
            institution: a.institution,
            name: a.name,
            type: a.type,
            mask: a.mask ?? '',
            available: money(a.available_balance_cents),
            current: money(a.current_balance_cents),
          })),
        ) + `\n${meta.stale ? 'STALE — run `ledger sync`' : 'fresh'}\n`,
      );
    }),
  );

program
  .command('categories')
  .description('list known categories with transaction counts (from local db)')
  .action(
    withCtx(program, ({ db, json }) => {
      const result = listCategories(db);
      if (json) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
        return;
      }
      process.stdout.write(
        formatTable(result.categories.map(c => ({ category: c.category, count: c.count }))) +
          `\n${result.meta.stale ? 'STALE — run `ledger sync`' : 'fresh'}\n`,
      );
    }),
  );

program
  .command('transactions')
  .description('query transactions (from local db; positive amounts are money out)')
  .option('--account <id>')
  .option('--from <date>', 'yyyy-mm-dd or relative: today, yesterday, this-month, last-month, N-days-ago')
  .option('--to <date>', 'yyyy-mm-dd or relative: today, yesterday, this-month, last-month, N-days-ago')
  .option(
    '--category <name>',
    "Plaid primary category, e.g. FOOD_AND_DRINK (case-insensitive; 'UNCATEGORIZED' for uncategorized transactions; run `ledger categories` to see valid values)",
  )
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
          process.stdout.write(JSON.stringify(transactionsResultView(result, { verbose: true }), null, 2) + '\n');
          return;
        }
        process.stdout.write(
          formatTable(
            result.transactions.map(t => ({
              date: t.date,
              amount: money(t.amount_cents),
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
  .requiredOption(
    '--from <date>',
    'yyyy-mm-dd or relative: today, yesterday, this-month, last-month, N-days-ago',
  )
  .requiredOption(
    '--to <date>',
    'yyyy-mm-dd or relative: today, yesterday, this-month, last-month, N-days-ago',
  )
  .option('--by <group>', 'category|merchant|month|account|payment_channel', 'category')
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
        if (!['category', 'merchant', 'month', 'account', 'payment_channel'].includes(groupBy)) {
          throw new Error(
            `--by must be category|merchant|month|account|payment_channel, got "${opts.by}"`,
          );
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
          process.stdout.write(JSON.stringify(spendingResultView(result), null, 2) + '\n');
          return;
        }
        process.stdout.write(
          formatTable(
            result.groups.map(g => ({
              [groupBy]: g.key,
              total: money(g.totalCents),
              count: g.count,
              share: `${(g.share * 100).toFixed(1)}%`,
            })),
          ) + `\ntotal: ${money(result.grandTotalCents)}\n`,
        );
      },
    ),
  );

const recurring = program
  .command('recurring')
  .description('recurring bills, subscriptions, and income streams (from local db)')
  .option('--direction <inflow|outflow>', 'only money in, or only money out')
  .option('--active', 'hide streams Plaid has marked as ended')
  .option('--frequency <freq>', 'WEEKLY, BIWEEKLY, SEMI_MONTHLY, MONTHLY, or ANNUALLY')
  .action(
    withCtx(
      program,
      ({ db, json }, opts: { direction?: string; active?: boolean; frequency?: string }) => {
        if (opts.direction !== undefined && opts.direction !== 'inflow' && opts.direction !== 'outflow') {
          fail(`--direction must be "inflow" or "outflow", got "${opts.direction}"`, EXIT_GENERAL, json);
        }
        const raw = listRecurring(db, {
          direction: opts.direction as 'inflow' | 'outflow' | undefined,
          activeOnly: opts.active,
          frequency: opts.frequency,
        });

        if (json) {
          process.stdout.write(JSON.stringify(recurringResultView(raw), null, 2) + '\n');
          return;
        }
        if (raw.streams.length === 0) {
          process.stdout.write(
            'No recurring streams stored. Run `ledger recurring refresh` to fetch them.\n',
          );
          return;
        }
        process.stdout.write(
          formatTable(
            raw.streams.map(s => ({
              direction: s.direction,
              merchant: s.merchant_name ?? s.description,
              frequency: s.frequency,
              // money() takes integer cents — same path as accounts/transactions/spending.
              average: money(
                s.average_amount_cents === null ? null : Math.abs(s.average_amount_cents),
              ),
              next: s.predicted_next_date ?? '-',
              status: s.status,
              active: s.is_active === 1 ? 'yes' : 'no',
            })),
          ) + '\n',
        );
        if (raw.meta.stale) {
          process.stderr.write(
            'These streams are more than 24h old. Run `ledger recurring refresh`.\n',
          );
        }
      },
    ),
  );

recurring
  .command('refresh')
  .description('refetch recurring streams from Plaid')
  .option('--item <id>', 'refresh only this institution')
  .action(
    withCtx(program, async ({ cfg, db, json }, opts: { item?: string }) => {
      const results = await refreshRecurring(db, clientFromConfig(cfg), { itemId: opts.item });
      printRecurringRefresh(results, json);
    }),
  );

program.parseAsync().catch(error => handleError(error, Boolean(program.opts()['json'])));
