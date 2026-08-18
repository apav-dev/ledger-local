# Forced Institution Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `ledger sync --force`, which calls `/transactions/refresh` to make Plaid pull from the institution *now* instead of returning whatever it last ingested on its own 1–4×/day schedule.

**Architecture:** One new client method, one new option threaded through `syncAll`, one CLI flag, one MCP argument. Refresh runs per Item before that Item's sync loop. It is never the default: `transactions_refresh` is a billed product on some plans, and the MCP tool description must say so plainly enough that a model does not reach for it routinely.

**Tech Stack:** TypeScript 7 (strict), better-sqlite3 12, plaid 45, vitest 4, commander 15.

**Spec:** `docs/superpowers/specs/2026-08-18-plaid-capability-expansion.md` (Feature 4)

**Depends on:** Plan 02 (`isConsentRequired`), Plan 03 if run after it.

**Settled by Plan 02's probe:** Plaid rejects `transactions_refresh` as an
`additional_consented_product` (INVALID_PRODUCT), so there is no consent step to
add. If `/transactions/refresh` is refused it is a dashboard product setting, not
something `ledger auth consent` can grant — any message about it must say so.

## Global Constraints

- Node >= 22, ESM, `pnpm` only.
- TypeScript strict. `pnpm typecheck` covers `src` and `tests`.
- Tests never reach the network. The Plaid SDK is injected via `PlaidSdk` and stubbed.
- Reads never hit the Plaid API. `sync` is a write path.
- Every CLI command supports `--json` except `init`.
- Exit codes: `0` ok, `1` general, `2` config, `3` needs re-authentication.
- Money is `INTEGER` cents in SQLite, dollars at every output boundary.
- No schema change in this plan.

## Behavioural facts that shape the design

- Plaid checks institutions for new transactions **1–4 times per day** on its own. `sync` alone returns the last ingest, so "did my paycheck land?" can be hours stale with no signal that it is.
- `/transactions/refresh` takes only `{ access_token }` and returns only a `request_id`. It **triggers** a pull; it does not return data. New transactions arrive through the next `/transactions/sync` call.
- The pull is not instantaneous. A `sync` immediately after a refresh may still return nothing new. This must be documented rather than papered over with a poll — a poll would burn wall-clock on every forced sync for a guarantee Plaid does not offer.
- Refresh is billed per call on some plans. Default-on would be a silent cost.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/core/plaid-client.ts` | Plaid transport | Modify — `refreshTransactions`, extend `PlaidSdk` and `LedgerPlaidApi` |
| `src/core/sync.ts` | Sync orchestration | Modify — `force` option on `syncAll` and `syncItem` |
| `src/cli/index.ts` | Command surface | Modify — `sync --force` |
| `src/mcp/server.ts` | MCP tools | Modify — `force` argument on `sync` |
| `tests/plaid-client.test.ts`, `tests/sync.test.ts`, `tests/mcp.test.ts` | | Modify |
| `README.md` | | Modify |

---

### Task 1: `refreshTransactions` on the Plaid client

**Files:**
- Modify: `src/core/plaid-client.ts` — `PlaidSdk`, `LedgerPlaidApi`, `PlaidClient`
- Test: `tests/plaid-client.test.ts`

**Interfaces:**
- Consumes: the `#call` retry funnel already in `PlaidClient`.
- Produces:
  ```ts
  // on PlaidSdk
  transactionsRefresh(req: { access_token: string }):
    Promise<{ data: TransactionsRefreshResponse }>;
  // on LedgerPlaidApi
  refreshTransactions(accessToken: string): Promise<void>;
  ```

- [ ] **Step 1: Write the failing tests**

Add to `tests/plaid-client.test.ts`:

```ts
describe('refreshTransactions', () => {
  it('calls /transactions/refresh with the access token', async () => {
    const seen: Array<{ access_token: string }> = [];
    const client = new PlaidClient(CFG, {
      sdk: stubSdk({
        transactionsRefresh: async req => {
          seen.push(req);
          return { data: { request_id: 'r' } as TransactionsRefreshResponse };
        },
      }),
    });

    await client.refreshTransactions('access-tok');

    expect(seen).toEqual([{ access_token: 'access-tok' }]);
  });

  it('returns nothing — the endpoint yields no data, only a trigger', async () => {
    const client = new PlaidClient(CFG, {
      sdk: stubSdk({
        transactionsRefresh: async () => ({ data: { request_id: 'r' } as TransactionsRefreshResponse }),
      }),
    });

    await expect(client.refreshTransactions('access-tok')).resolves.toBeUndefined();
  });

  it('propagates a reauth failure so the caller can classify it', async () => {
    const client = new PlaidClient(CFG, {
      sdk: stubSdk({
        transactionsRefresh: async () => {
          throw {
            response: {
              status: 400,
              data: {
                error_code: 'ITEM_LOGIN_REQUIRED',
                error_type: 'ITEM_ERROR',
                error_message: 'login required',
              },
            },
          };
        },
      }),
    });

    const error = await client.refreshTransactions('access-tok').catch((e: unknown) => e);
    expect(isReauthRequired(error)).toBe(true);
  });
});
```

Add `TransactionsRefreshResponse` to the type imports at the top of the test file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/plaid-client.test.ts -t refreshTransactions`
Expected: FAIL — `refreshTransactions` is not a method on `PlaidClient`.

- [ ] **Step 3: Implement**

In `src/core/plaid-client.ts`, add `TransactionsRefreshResponse` to the `plaid` type import list.

Add to `PlaidSdk`:

```ts
  transactionsRefresh(req: {
    access_token: string;
  }): Promise<{ data: TransactionsRefreshResponse }>;
```

Add to `LedgerPlaidApi`:

```ts
  /**
   * Asks Plaid to pull from the institution now rather than on its own 1-4x
   * daily schedule. Returns no data — new transactions arrive through the next
   * `/transactions/sync`, and not necessarily immediately.
   */
  refreshTransactions(accessToken: string): Promise<void>;
```

Add to `PlaidClient`, after `syncTransactions`:

```ts
  /**
   * Billed per call on some plans, which is why nothing calls this by default.
   *
   * Returns void deliberately: the response carries only a request_id, and
   * handing that back would invite a caller to treat it as a completion signal.
   */
  refreshTransactions(accessToken: string): Promise<void> {
    return this.#call('/transactions/refresh', () =>
      this.#api.transactionsRefresh({ access_token: accessToken }),
    ).then(() => undefined);
  }
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run tests/plaid-client.test.ts`
Expected: PASS. `pnpm typecheck` fails wherever a test builds a `LedgerPlaidApi` stub without the new method — add a `refreshTransactions` that throws `new Error('unexpected call')` to each, matching the existing convention for unused stub methods.

- [ ] **Step 5: Commit**

```bash
git add src/core/plaid-client.ts tests/plaid-client.test.ts
git commit -m "feat(plaid): add refreshTransactions for on-demand institution pulls"
```

---

### Task 2: `force` option on sync

**Files:**
- Modify: `src/core/sync.ts` — `syncItem`, `syncAll`, `AccountSyncResult`
- Test: `tests/sync.test.ts`

**Interfaces:**
- Consumes: `refreshTransactions` (Task 1).
- Produces:
  ```ts
  // syncAll's options object gains:
  force?: boolean | undefined;
  // AccountSyncResult gains:
  refreshed?: boolean | undefined;
  ```
  Both optional, so every existing caller compiles unchanged.

- [ ] **Step 1: Write the failing tests**

Add to `tests/sync.test.ts`:

```ts
describe('sync --force', () => {
  it('does not refresh unless asked', async () => {
    const db = seedItemDb();
    let refreshes = 0;
    const api = fakeApi({
      refreshTransactions: async () => { refreshes += 1; },
      syncTransactions: async () => page({ added: [txn('t1')] }),
    });

    await syncAll(db, api);

    expect(refreshes).toBe(0);
  });

  it('refreshes once per item before syncing it', async () => {
    const db = seedItemDb();
    const order: string[] = [];
    const api = fakeApi({
      refreshTransactions: async () => { order.push('refresh'); },
      getAccounts: async () => { order.push('accounts'); return [account('acc_1')]; },
      syncTransactions: async () => { order.push('sync'); return page({ added: [txn('t1')] }); },
    });

    await syncAll(db, api, { force: true });

    // Refresh must precede the sync, or the pull it triggers cannot be picked up.
    expect(order[0]).toBe('refresh');
    expect(order.filter(o => o === 'refresh')).toHaveLength(1);
  });

  it('marks results as refreshed so the caller can report it', async () => {
    const db = seedItemDb();
    const api = fakeApi({
      refreshTransactions: async () => {},
      syncTransactions: async () => page({ added: [txn('t1')] }),
    });

    const results = await syncAll(db, api, { force: true });

    expect(results.every(r => r.refreshed === true)).toBe(true);
  });

  it('reports a failed refresh as a failed item instead of syncing stale data silently', async () => {
    const db = seedItemDb();
    const api = fakeApi({
      refreshTransactions: async () => {
        throw new PlaidApiError('nope', 'ITEM_LOGIN_REQUIRED', 'ITEM_ERROR', 400);
      },
      syncTransactions: async () => page({ added: [txn('t1')] }),
    });

    const results = await syncAll(db, api, { force: true });

    expect(results.every(r => r.ok)).toBe(false);
    expect(results.some(r => r.needsReauth === true)).toBe(true);
  });

  it('omits the refreshed flag entirely on a normal sync', async () => {
    const db = seedItemDb();
    const api = fakeApi({ syncTransactions: async () => page({ added: [txn('t1')] }) });

    const results = await syncAll(db, api);

    expect(results[0]?.refreshed).toBeUndefined();
  });
});
```

`seedItemDb`, `fakeApi`, `account`, `txn`, and `page` are this suite's existing helpers. Extend `fakeApi` to accept a `refreshTransactions` override if it does not already take partials.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/sync.test.ts -t "sync --force"`
Expected: FAIL — `force` is not an accepted option and `refreshed` is not on the result.

- [ ] **Step 3: Add the result field**

In `src/core/sync.ts`, add to `AccountSyncResult`:

```ts
  /**
   * True when `/transactions/refresh` ran for this account's Item before the
   * sync. Undefined on a normal sync, so the flag never appears in JSON unless
   * it happened.
   */
  refreshed?: boolean | undefined;
```

- [ ] **Step 4: Refresh inside `syncItem`**

`syncItem` already has a `try` that turns per-Item failures into failed results, which is exactly where a refresh failure belongs. Add `force` to its signature and put the call at the top of the existing `try`, before `getAccounts`:

```ts
async function syncItem(
  db: Db,
  api: LedgerPlaidApi,
  item: ItemRow,
  now: () => number,
  maxPages: number,
  force: boolean,
): Promise<AccountSyncResult[]> {
  const names = new Map<string, string>();
  const tallies = new Map<string, Tally>();

  try {
    // Before anything else, or the pull it triggers cannot be picked up by the
    // sync below. Inside the try so a refresh failure is reported as a failed
    // Item rather than silently syncing stale data as if the force had worked.
    if (force) await api.refreshTransactions(item.access_token);

    // `/accounts/balance/get` rather than the `accounts` in the sync response:
    // balances elsewhere may be cached, and this endpoint forces a live read.
    const accounts = await api.getAccounts(item.access_token);
```

Then set the flag on every result this function builds. Wherever `syncItem` constructs an `AccountSyncResult` — both the success path and the failure path — add:

```ts
      refreshed: force ? true : undefined,
```

- [ ] **Step 5: Thread `force` through `syncAll`**

Add `force?: boolean | undefined;` to `syncAll`'s options type, then pass it down at the `syncItem` call site:

```ts
    results.push(...(await syncItem(db, api, item, now, maxPages, opts.force === true)));
```

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run tests/sync.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/core/sync.ts tests/sync.test.ts
git commit -m "feat(sync): add force option that refreshes the institution first"
```

---

### Task 3: `ledger sync --force` and the MCP `force` argument

**Files:**
- Modify: `src/cli/index.ts` — the `sync` command
- Modify: `src/mcp/server.ts` — the `sync` tool
- Test: `tests/mcp.test.ts`

**Interfaces:**
- Consumes: `syncAll`'s `force` option (Task 2).
- Produces: no new exported types.

- [ ] **Step 1: Add the CLI flag**

In `src/cli/index.ts`, in the `sync` registration, add the option and pass it:

```ts
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
```

- [ ] **Step 2: Verify the flag**

Run: `pnpm cli -- sync --help`
Expected: `--force` is listed with the billing caveat.

- [ ] **Step 3: Write the failing MCP test**

Add to `tests/mcp.test.ts`:

```ts
describe('sync force', () => {
  it('does not refresh by default', async () => {
    const db = seedDb();
    let refreshes = 0;
    const api = fakeApi({
      refreshTransactions: async () => { refreshes += 1; },
      getAccounts: async () => [],
      syncTransactions: async () => page({}),
    });

    await callTool(db, 'sync', {}, api);

    expect(refreshes).toBe(0);
  });

  it('refreshes when force is true', async () => {
    const db = seedDb();
    let refreshes = 0;
    const api = fakeApi({
      refreshTransactions: async () => { refreshes += 1; },
      getAccounts: async () => [],
      syncTransactions: async () => page({}),
    });

    await callTool(db, 'sync', { force: true }, api);

    expect(refreshes).toBe(1);
  });
});
```

`callTool`, `fakeApi`, and `page` are placeholders for this suite's existing helpers — use their real names. If the suite's tool-invocation helper does not currently accept an injected API, extend it; the MCP server already takes `api` through `Deps`.

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm vitest run tests/mcp.test.ts -t "sync force"`
Expected: FAIL — `force` is not in the tool's input schema, so it is stripped before reaching `syncAll`.

- [ ] **Step 5: Add the MCP argument**

In `src/mcp/server.ts`, replace the `sync` tool registration's description and schema with:

```ts
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
```

and pass it through in the handler:

```ts
        const results = await syncAll(deps.db, deps.api, {
          accountId: args.accountId,
          force: args.force,
        });
```

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run tests/mcp.test.ts && pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Update the README**

In the CLI block, change the sync line to:

```
ledger sync [--account|--item id] refresh from Plaid
ledger sync --force               make Plaid pull from the bank now
```

Add a section after **How sync works**:

```markdown
### `--force`: making Plaid pull now

Plaid checks each institution on its own schedule, roughly one to four times a
day. A plain `ledger sync` returns whatever that last check found, so a
transaction from the last few hours can be legitimately missing with nothing to
indicate it.

`ledger sync --force` calls `/transactions/refresh` first, which asks Plaid to
go to the bank immediately.

Two caveats, both real:

- **It may be billed per call.** `transactions_refresh` is a separate Plaid
  product. It is off by default and should stay that way for routine syncs.
- **The pull is asynchronous.** The refresh is a request, not a completed
  transfer. Anything it finds may only show up on the next `ledger sync`.

Use it when the answer depends on the last few hours — "did my paycheck land",
"did that payment clear". For everything else, plain `sync` is correct and free.
```

- [ ] **Step 8: Commit**

```bash
git add src/cli/index.ts src/mcp/server.ts tests/mcp.test.ts README.md
git commit -m "feat: add sync --force and the MCP force argument"
```

---

## Self-Review

**Spec coverage.** Feature 4 asks for `/transactions/refresh` behind an explicit `ledger sync --force` (Tasks 1–3), a `force` argument on the MCP `sync` tool with the billing caveat in its description (Task 3 Step 5), and that it never be the default (asserted directly in Task 2 Step 1's first and last cases, and in Task 3 Step 3's first case). Success criterion 6 is those tests.

**Placeholders.** None. Three steps lean on existing test helpers whose exact names this plan cannot know; each says so and describes what to substitute rather than inventing a name.

**Type consistency.** `force` is `boolean | undefined` everywhere: commander's option, `syncAll`'s option, `syncItem`'s parameter (narrowed to a plain `boolean` at the single call site via `opts.force === true`), and the MCP `z.boolean().optional()`. `refreshed` on `AccountSyncResult` is `boolean | undefined` and set to `undefined` rather than `false` on normal syncs, matching how `needsReauth` already behaves in that type so the JSON output stays quiet.

**Design note.** The refresh call sits inside `syncItem`'s existing `try`, not in `syncAll`. That is what makes a refresh failure surface as a failed Item with the right `needsReauth` classification, instead of either aborting every other bank's sync or — worse — being swallowed so a forced sync silently returns stale data as though the force had worked.

**Known limitation, documented rather than engineered around.** A forced sync may still miss a very recent transaction, because Plaid's institution pull is asynchronous. Polling for it would spend wall-clock on every forced sync chasing a guarantee Plaid does not offer, so both the CLI output (Task 3 Step 1) and the MCP tool description (Task 3 Step 5) say so instead.
