# Recurring Streams Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store Plaid's recurring transaction streams locally and expose them through `ledger recurring` and an MCP `list_recurring` tool, so an agent can answer subscription, bill, and paycheck questions that no amount of local analysis over the transactions table can reach.

**Architecture:** `/transactions/recurring/get` returns a full snapshot per Item with no cursor, so storage is replace-per-Item inside one transaction — the opposite of the incremental transactions path, and the single most important thing to get right here. A new `src/core/recurring.ts` owns fetch, mapping, and query; `db.ts` gains a `recurring_streams` table at schema v5; the CLI and MCP read through shared views.

**Tech Stack:** TypeScript 7 (strict), better-sqlite3 12, plaid 45, vitest 4, commander 15.

**Spec:** `docs/superpowers/specs/2026-08-18-plaid-capability-expansion.md` (Feature 3)

**Depends on:** Plan 01 (schema v3), Plan 02 (schema v4, `recurring_transactions` consent, `itemConsent`). This plan bumps to v5.

## Global Constraints

- Node >= 22, ESM, `pnpm` only.
- TypeScript strict. `pnpm typecheck` covers `src` and `tests`.
- Money is `INTEGER` cents in SQLite, decimal dollars at every output boundary. Conversion only in `src/core/money.ts` (ingest) and `src/core/views.ts` (egress).
- Plaid's amount sign is preserved in storage: **positive means money left the account.** Aggregate and summary outputs report positive magnitudes.
- Tests never reach the network. The Plaid SDK is injected via `PlaidSdk` and stubbed.
- Reads never hit the Plaid API. `ledger recurring` reads locally; `ledger recurring refresh` is the only network path.
- Every CLI command supports `--json` except `init`.
- CLI and MCP share the same view functions.
- Exit codes: `0` ok, `1` general, `2` config, `3` needs re-authentication.
- **No migration code.** Schema changes are `SCHEMA` edits plus a `SCHEMA_VERSION` bump; delete the sandbox database when the version changes. Legitimate only until the first production Item exists — see Plan 01.
- **This plan must land before any production bank is linked.**

## Domain facts that drive the design

Verified against `plaid@45` types and Plaid docs on 2026-08-18.

- The response is `{ inflow_streams: TransactionStream[], outflow_streams: TransactionStream[], updated_datetime: string }`. There is **no cursor and no `removed` list.** A stream that disappears from the response is gone, and the only correct way to represent that is to replace the Item's whole set.
- `TransactionStreamAmount.amount` is `number | undefined`. Amount columns must be nullable.
- `frequency`: `UNKNOWN | WEEKLY | BIWEEKLY | SEMI_MONTHLY | MONTHLY | ANNUALLY`.
- `status`: `UNKNOWN | MATURE | EARLY_DETECTION | TOMBSTONED`. `TOMBSTONED` means a previously-detected stream stopped appearing — a free "this subscription ended" signal.
- `predicted_next_date` is `string | null | undefined` — Plaid sets it only when it can predict.
- `is_user_modified` and `last_user_modified_datetime` are **deprecated**; `is_user_modified` is always `false`. Do not store them and do not build editing.
- Streams are not recalculated for a newly added account until the next periodic update or a `/transactions/refresh` call (Plan 04).

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/core/plaid-client.ts` | Plaid transport | Modify — `getRecurringStreams`, extend `PlaidSdk` and `LedgerPlaidApi` |
| `src/core/db.ts` | Schema and row types | Modify — schema v5, `recurring_streams`, `replaceRecurringStreams`, `listRecurringStreamRows` |
| `src/core/recurring.ts` | Fetch, map, refresh, query | Create |
| `src/core/views.ts` | Output boundary | Modify — `recurringStreamView`, `recurringResultView` |
| `src/cli/index.ts` | Command surface | Modify — `ledger recurring [refresh]` |
| `src/mcp/server.ts` | MCP tools | Modify — `list_recurring` |
| `tests/recurring.test.ts` | | Create |
| `tests/db.test.ts`, `tests/views.test.ts`, `tests/plaid-client.test.ts`, `tests/mcp.test.ts`, `tests/helpers.ts` | | Modify |
| `README.md` | | Modify |

---

### Task 1: Fetch recurring streams from Plaid

**Files:**
- Modify: `src/core/plaid-client.ts` — `PlaidSdk`, `LedgerPlaidApi`, `PlaidClient`, plus a new error predicate
- Test: `tests/plaid-client.test.ts`

**Interfaces:**
- Consumes: the `#call` retry funnel already in `PlaidClient`.
- Produces:
  ```ts
  // on PlaidSdk
  transactionsRecurringGet(req: { access_token: string }):
    Promise<{ data: TransactionsRecurringGetResponse }>;
  // on LedgerPlaidApi
  getRecurringStreams(accessToken: string): Promise<TransactionsRecurringGetResponse>;
  // new export
  export function isConsentRequired(error: unknown): boolean;
  ```

- [ ] **Step 1: Write the failing tests**

Add to `tests/plaid-client.test.ts`:

```ts
describe('getRecurringStreams', () => {
  it('returns the raw response', async () => {
    const client = new PlaidClient(CFG, {
      sdk: stubSdk({
        transactionsRecurringGet: async () => ({
          data: {
            inflow_streams: [],
            outflow_streams: [],
            updated_datetime: '2026-08-18T00:00:00Z',
            request_id: 'r',
          } as TransactionsRecurringGetResponse,
        }),
      }),
    });

    const result = await client.getRecurringStreams('access-tok');

    expect(result.updated_datetime).toBe('2026-08-18T00:00:00Z');
  });

  it('surfaces a consent failure as a classifiable error', async () => {
    const client = new PlaidClient(CFG, {
      sdk: stubSdk({
        transactionsRecurringGet: async () => {
          throw {
            response: {
              status: 400,
              data: {
                error_code: 'ADDITIONAL_CONSENT_REQUIRED',
                error_type: 'INVALID_INPUT',
                error_message: 'consent required',
              },
            },
          };
        },
      }),
    });

    await expect(client.getRecurringStreams('access-tok')).rejects.toSatisfy(isConsentRequired);
  });
});
```

If this suite's `expect` has no `toSatisfy`, replace that last line with:

```ts
    const error = await client.getRecurringStreams('access-tok').catch((e: unknown) => e);
    expect(isConsentRequired(error)).toBe(true);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/plaid-client.test.ts -t getRecurringStreams`
Expected: FAIL — `getRecurringStreams` is not a method on `PlaidClient`.

- [ ] **Step 3: Add the error predicate**

In `src/core/plaid-client.ts`, add after `isItemNotFound`:

```ts
/**
 * The Item has not consented to the product being called. Distinct from a
 * reauth: the credentials are fine, the permission grant is not — and the fix
 * is `ledger auth consent <item_id>`, which is update mode, not a re-link.
 *
 * Two codes because Plaid reports this differently depending on whether the
 * product was never consented or the consent has since lapsed.
 */
export function isConsentRequired(error: unknown): boolean {
  return (
    error instanceof PlaidApiError &&
    (error.errorCode === 'ADDITIONAL_CONSENT_REQUIRED' ||
      error.errorCode === 'PRODUCTS_NOT_SUPPORTED' ||
      error.errorCode === 'INSUFFICIENT_CREDENTIALS')
  );
}
```

- [ ] **Step 4: Extend the interfaces and implement**

Add `TransactionsRecurringGetResponse` to the type import list at the top of the file.

Add to `PlaidSdk`:

```ts
  transactionsRecurringGet(req: {
    access_token: string;
  }): Promise<{ data: TransactionsRecurringGetResponse }>;
```

Add to `LedgerPlaidApi`:

```ts
  /**
   * A full snapshot of every recurring stream on the Item. No cursor, no
   * `removed` list — callers must replace their stored set, not merge into it.
   */
  getRecurringStreams(accessToken: string): Promise<TransactionsRecurringGetResponse>;
```

Add to `PlaidClient`, after `syncTransactions`:

```ts
  getRecurringStreams(accessToken: string): Promise<TransactionsRecurringGetResponse> {
    return this.#call('/transactions/recurring/get', () =>
      this.#api.transactionsRecurringGet({ access_token: accessToken }),
    );
  }
```

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run tests/plaid-client.test.ts`
Expected: PASS. `pnpm typecheck` fails wherever a test constructs a `LedgerPlaidApi` stub without the new method — fix each by adding a `getRecurringStreams` that throws `new Error('unexpected call')`, matching how those stubs already handle unused methods.

- [ ] **Step 6: Commit**

```bash
git add src/core/plaid-client.ts tests/plaid-client.test.ts
git commit -m "feat(plaid): add getRecurringStreams and consent-required classification"
```

---

### Task 2: Schema v5 — the `recurring_streams` table

**Files:**
- Modify: `src/core/db.ts` — `SCHEMA`, `SCHEMA_VERSION`, new `RecurringStreamRow`, `replaceRecurringStreams`, `listRecurringStreamRows`; `removeItem` must clear streams too
- Test: `tests/db.test.ts`

**Interfaces:**
- Consumes: schema v4 from Plan 02.
- Produces:
  ```ts
  export interface RecurringStreamRow {
    stream_id: string;
    item_id: string;
    account_id: string;
    direction: string;              // 'inflow' | 'outflow'
    description: string;
    merchant_name: string | null;
    category_primary: string | null;
    category_detailed: string | null;
    frequency: string;
    status: string;
    is_active: number;              // 0 | 1, SQLite has no boolean
    first_date: string;
    last_date: string;
    predicted_next_date: string | null;
    average_amount_cents: number | null;
    last_amount_cents: number | null;
    transaction_count: number;
    refreshed_at: number;
  }
  export function replaceRecurringStreams(
    db: Db, itemId: string, rows: readonly RecurringStreamRow[],
  ): number;
  export function listRecurringStreamRows(db: Db): RecurringStreamRow[];
  export function lastRecurringRefreshAt(db: Db): number | null;
  ```

- [ ] **Step 1: Write the failing tests**

Add to `tests/db.test.ts`:

```ts
describe('recurring_streams', () => {
  const stream = (
    id: string,
    over: Partial<RecurringStreamRow> = {},
  ): RecurringStreamRow => ({
    stream_id: id, item_id: 'item_1', account_id: 'acc_1', direction: 'outflow',
    description: 'NETFLIX', merchant_name: 'Netflix',
    category_primary: 'ENTERTAINMENT', category_detailed: 'ENTERTAINMENT_STREAMING',
    frequency: 'MONTHLY', status: 'MATURE', is_active: 1,
    first_date: '2026-01-15', last_date: '2026-08-15',
    predicted_next_date: '2026-09-15',
    average_amount_cents: 1599, last_amount_cents: 1599,
    transaction_count: 8, refreshed_at: 1000,
    ...over,
  });

  it('replaces the whole set for an item rather than merging', () => {
    const db = seedDb();
    replaceRecurringStreams(db, 'item_1', [stream('s1'), stream('s2')]);

    // Plaid returns a full snapshot with no `removed` list, so a stream missing
    // from a later response has ended and must disappear locally.
    const removed = replaceRecurringStreams(db, 'item_1', [stream('s2')]);

    expect(removed).toBe(2);
    expect(listRecurringStreamRows(db).map(s => s.stream_id)).toEqual(['s2']);
  });

  it('leaves another item\'s streams alone', () => {
    const db = seedDb();
    upsertItem(db, {
      id: 'item_2', access_token: 'tok2', institution: 'Amex',
      institution_id: 'ins_9', created_at: 2, consented_products: null,
    });
    upsertAccount(db, {
      id: 'acc_3', item_id: 'item_2', name: 'Amex', official_name: null,
      institution: 'Amex', type: 'credit', subtype: 'credit card', mask: '3333',
      iso_currency_code: 'USD', available_balance_cents: null, current_balance_cents: null,
    });
    replaceRecurringStreams(db, 'item_1', [stream('s1')]);
    replaceRecurringStreams(db, 'item_2', [
      stream('s9', { item_id: 'item_2', account_id: 'acc_3' }),
    ]);

    replaceRecurringStreams(db, 'item_1', []);

    expect(listRecurringStreamRows(db).map(s => s.stream_id)).toEqual(['s9']);
  });

  it('accepts a stream with no amount and no predicted date', () => {
    const db = seedDb();

    replaceRecurringStreams(db, 'item_1', [
      stream('s_sparse', {
        average_amount_cents: null, last_amount_cents: null, predicted_next_date: null,
      }),
    ]);

    const row = listRecurringStreamRows(db)[0];
    expect(row?.average_amount_cents).toBeNull();
    expect(row?.predicted_next_date).toBeNull();
  });

  it('drops an item\'s streams when the item is removed', () => {
    const db = seedDb();
    replaceRecurringStreams(db, 'item_1', [stream('s1')]);

    removeItem(db, 'item_1');

    expect(listRecurringStreamRows(db)).toEqual([]);
  });

  it('stamps a fresh database at version 5 with the table present', () => {
    const db = openDb(':memory:', 'sandbox');

    expect(db.pragma('user_version', { simple: true })).toBe(5);
    expect(() => db.prepare('SELECT * FROM recurring_streams').all()).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/db.test.ts -t recurring_streams`
Expected: FAIL — `replaceRecurringStreams` is not exported.

- [ ] **Step 3: Add the table to `SCHEMA`**

Append inside the `SCHEMA` template literal:

```sql
CREATE TABLE IF NOT EXISTS recurring_streams (
  stream_id            TEXT PRIMARY KEY,
  item_id              TEXT NOT NULL REFERENCES items(id),
  account_id           TEXT NOT NULL REFERENCES accounts(id),
  direction            TEXT NOT NULL,
  description          TEXT NOT NULL,
  merchant_name        TEXT,
  category_primary     TEXT,
  category_detailed    TEXT,
  frequency            TEXT NOT NULL,
  status               TEXT NOT NULL,
  is_active            INTEGER NOT NULL,
  first_date           TEXT NOT NULL,
  last_date            TEXT NOT NULL,
  predicted_next_date  TEXT,
  average_amount_cents INTEGER,
  last_amount_cents    INTEGER,
  transaction_count    INTEGER NOT NULL,
  refreshed_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stream_item ON recurring_streams(item_id);
CREATE INDEX IF NOT EXISTS idx_stream_next ON recurring_streams(predicted_next_date);
```

- [ ] **Step 4: Bump the version and reset your sandbox database**

```ts
const SCHEMA_VERSION = 5;
```

Then delete the sandbox database, which the bump has just made unopenable:

```bash
rm -f ~/.local/share/ledger/ledger.db*
```

Free right now, and not after the first production link — which is why every
schema change in this series has to land first.

- [ ] **Step 5: Add the row type and accessors**

Append to `src/core/db.ts`:

```ts
// --------------------------------------------------- recurring streams

export interface RecurringStreamRow {
  stream_id: string;
  item_id: string;
  account_id: string;
  /** 'inflow' (money arriving) or 'outflow' (money leaving). */
  direction: string;
  description: string;
  merchant_name: string | null;
  category_primary: string | null;
  category_detailed: string | null;
  /** UNKNOWN | WEEKLY | BIWEEKLY | SEMI_MONTHLY | MONTHLY | ANNUALLY */
  frequency: string;
  /**
   * UNKNOWN | MATURE | EARLY_DETECTION | TOMBSTONED.
   * TOMBSTONED means a previously detected stream stopped arriving — the signal
   * that a subscription ended.
   */
  status: string;
  /** SQLite has no boolean: 0 or 1. */
  is_active: number;
  first_date: string;
  last_date: string;
  /** Null when Plaid cannot predict the next occurrence. */
  predicted_next_date: string | null;
  /** Integer cents, Plaid-native sign. Null when Plaid reports no amount. */
  average_amount_cents: number | null;
  /** Integer cents, Plaid-native sign. Null when Plaid reports no amount. */
  last_amount_cents: number | null;
  transaction_count: number;
  refreshed_at: number;
}

/**
 * Replaces every stream belonging to `itemId`, returning how many were deleted.
 *
 * Replace, never merge. `/transactions/recurring/get` returns a full snapshot
 * with no cursor and no `removed` list, so a stream absent from the response has
 * ended. Merging would leave dead subscriptions in the table forever, and a
 * "what am I paying for" answer built on it would be wrong in the one direction
 * that matters.
 *
 * One transaction, so a failure mid-write cannot leave the Item with a partial
 * set that looks authoritative.
 */
export function replaceRecurringStreams(
  db: Db,
  itemId: string,
  rows: readonly RecurringStreamRow[],
): number {
  const run = db.transaction((): number => {
    const deleted = db
      .prepare('DELETE FROM recurring_streams WHERE item_id = ?')
      .run(itemId).changes;
    const stmt = db.prepare(
      `INSERT INTO recurring_streams (
         stream_id, item_id, account_id, direction, description, merchant_name,
         category_primary, category_detailed, frequency, status, is_active,
         first_date, last_date, predicted_next_date, average_amount_cents,
         last_amount_cents, transaction_count, refreshed_at
       ) VALUES (
         @stream_id, @item_id, @account_id, @direction, @description, @merchant_name,
         @category_primary, @category_detailed, @frequency, @status, @is_active,
         @first_date, @last_date, @predicted_next_date, @average_amount_cents,
         @last_amount_cents, @transaction_count, @refreshed_at
       )`,
    );
    for (const row of rows) stmt.run(row);
    return deleted;
  });
  return run();
}

export function listRecurringStreamRows(db: Db): RecurringStreamRow[] {
  return db
    .prepare(
      `SELECT * FROM recurring_streams
       ORDER BY direction, ABS(COALESCE(average_amount_cents, 0)) DESC, description`,
    )
    .all() as RecurringStreamRow[];
}

/** Oldest refresh across all streams, or null when none are stored. */
export function lastRecurringRefreshAt(db: Db): number | null {
  const row = db.prepare('SELECT MIN(refreshed_at) AS oldest FROM recurring_streams').get() as {
    oldest: number | null;
  };
  return row.oldest;
}
```

- [ ] **Step 6: Clear streams on item removal**

`removeItem` deletes transactions and accounts, and streams reference both. Without this, removal aborts on the foreign key. In `removeItem`, add before the accounts delete:

```ts
    db.prepare('DELETE FROM recurring_streams WHERE item_id = ?').run(itemId);
```

- [ ] **Step 7: Run the tests**

Run: `pnpm vitest run tests/db.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/core/db.ts tests/db.test.ts
git commit -m "feat(db): schema v5 — recurring_streams, replaced per item not merged"
```

---

### Task 3: Map and refresh streams

**Files:**
- Create: `src/core/recurring.ts`
- Create: `tests/recurring.test.ts`

**Interfaces:**
- Consumes: `getRecurringStreams`, `isConsentRequired`, `isReauthRequired` (Task 1); `RecurringStreamRow`, `replaceRecurringStreams`, `listRecurringStreamRows`, `lastRecurringRefreshAt` (Task 2); `itemConsent` (Plan 02 Task 3); `toCentsOrNull` (`src/core/money.ts`).
- Produces:
  ```ts
  export function toRecurringRows(
    response: TransactionsRecurringGetResponse, itemId: string, refreshedAt: number,
  ): RecurringStreamRow[];

  export interface RecurringRefreshResult {
    itemId: string; institution: string; ok: boolean;
    streams: number; removed: number;
    error?: string; needsReauth?: boolean | undefined; needsConsent?: boolean | undefined;
  }
  export function refreshRecurring(
    db: Db, api: LedgerPlaidApi, opts?: { itemId?: string | undefined; now?: (() => number) | undefined },
  ): Promise<RecurringRefreshResult[]>;

  export interface RecurringFilters {
    direction?: 'inflow' | 'outflow' | undefined;
    activeOnly?: boolean | undefined;
    frequency?: string | undefined;
  }
  export function listRecurring(
    db: Db, f?: RecurringFilters, now?: () => number,
  ): { streams: RecurringStreamRow[]; meta: QueryMeta };
  ```

- [ ] **Step 1: Write the failing tests**

Create `tests/recurring.test.ts`:

```ts
import type { TransactionStream, TransactionsRecurringGetResponse } from 'plaid';
import { describe, expect, it } from 'vitest';
import { listRecurringStreamRows, replaceRecurringStreams, type Db } from '../src/core/db.js';
import { PlaidApiError, type LedgerPlaidApi } from '../src/core/plaid-client.js';
import { listRecurring, refreshRecurring, toRecurringRows } from '../src/core/recurring.js';
import { NOW, seedDb } from './helpers.js';

function stream(id: string, over: Partial<TransactionStream> = {}): TransactionStream {
  return {
    account_id: 'acc_1',
    stream_id: id,
    category: null,
    category_id: null,
    description: 'NETFLIX',
    merchant_name: 'Netflix',
    first_date: '2026-01-15',
    last_date: '2026-08-15',
    predicted_next_date: '2026-09-15',
    frequency: 'MONTHLY' as TransactionStream['frequency'],
    transaction_ids: ['t1', 't2', 't3'],
    average_amount: { amount: 15.99, iso_currency_code: 'USD', unofficial_currency_code: null },
    last_amount: { amount: 15.99, iso_currency_code: 'USD', unofficial_currency_code: null },
    is_active: true,
    status: 'MATURE' as TransactionStream['status'],
    personal_finance_category: {
      primary: 'ENTERTAINMENT',
      detailed: 'ENTERTAINMENT_STREAMING',
    },
    is_user_modified: false,
    ...over,
  };
}

function response(over: Partial<TransactionsRecurringGetResponse> = {}): TransactionsRecurringGetResponse {
  return {
    inflow_streams: [],
    outflow_streams: [],
    updated_datetime: '2026-08-18T00:00:00Z',
    request_id: 'r',
    ...over,
  } as TransactionsRecurringGetResponse;
}

function fakeApi(over: Partial<LedgerPlaidApi> = {}): LedgerPlaidApi {
  const unused = () => { throw new Error('unexpected call'); };
  return {
    getAccounts: unused as never,
    syncTransactions: unused as never,
    createLinkToken: unused as never,
    getLinkSession: unused as never,
    exchangePublicToken: unused as never,
    itemRemove: unused as never,
    getRecurringStreams: unused as never,
    ...over,
  };
}

describe('toRecurringRows', () => {
  it('tags direction and converts dollars to cents', () => {
    const rows = toRecurringRows(
      response({ outflow_streams: [stream('s_out')], inflow_streams: [stream('s_in')] }),
      'item_1',
      NOW,
    );

    expect(rows).toHaveLength(2);
    expect(rows.find(r => r.stream_id === 's_out')?.direction).toBe('outflow');
    expect(rows.find(r => r.stream_id === 's_in')?.direction).toBe('inflow');
    expect(rows[0]?.average_amount_cents).toBe(1599);
    expect(rows[0]?.transaction_count).toBe(3);
    expect(rows[0]?.refreshed_at).toBe(NOW);
  });

  it('tolerates a stream with no amount and no predicted date', () => {
    const rows = toRecurringRows(
      response({
        outflow_streams: [
          stream('s_sparse', {
            average_amount: { iso_currency_code: 'USD', unofficial_currency_code: null },
            last_amount: { iso_currency_code: 'USD', unofficial_currency_code: null },
            predicted_next_date: null,
          }),
        ],
      }),
      'item_1',
      NOW,
    );

    expect(rows[0]?.average_amount_cents).toBeNull();
    expect(rows[0]?.last_amount_cents).toBeNull();
    expect(rows[0]?.predicted_next_date).toBeNull();
  });

  it('stores is_active as 0 or 1', () => {
    const rows = toRecurringRows(
      response({ outflow_streams: [stream('s_dead', { is_active: false, status: 'TOMBSTONED' as never })] }),
      'item_1',
      NOW,
    );

    expect(rows[0]?.is_active).toBe(0);
    expect(rows[0]?.status).toBe('TOMBSTONED');
  });
});

describe('refreshRecurring', () => {
  it('stores streams and reports the count', async () => {
    const db = seedDb();
    const api = fakeApi({
      getRecurringStreams: async () => response({ outflow_streams: [stream('s1'), stream('s2')] }),
    });

    const results = await refreshRecurring(db, api, { now: () => NOW });

    expect(results).toEqual([
      { itemId: 'item_1', institution: 'Chase', ok: true, streams: 2, removed: 0 },
    ]);
    expect(listRecurringStreamRows(db)).toHaveLength(2);
  });

  it('reports a consent failure with an actionable flag and leaves stored streams alone', async () => {
    const db = seedDb();
    replaceRecurringStreams(db, 'item_1', toRecurringRows(
      response({ outflow_streams: [stream('s_old')] }), 'item_1', NOW,
    ));
    const api = fakeApi({
      getRecurringStreams: async () => {
        throw new PlaidApiError('nope', 'ADDITIONAL_CONSENT_REQUIRED', 'INVALID_INPUT', 400);
      },
    });

    const results = await refreshRecurring(db, api, { now: () => NOW });

    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.needsConsent).toBe(true);
    expect(results[0]?.error).toMatch(/ledger auth consent/);
    // A failed refresh must not wipe the previous snapshot.
    expect(listRecurringStreamRows(db)).toHaveLength(1);
  });

  it('reports a reauth failure distinctly from a consent failure', async () => {
    const db = seedDb();
    const api = fakeApi({
      getRecurringStreams: async () => {
        throw new PlaidApiError('nope', 'ITEM_LOGIN_REQUIRED', 'ITEM_ERROR', 400);
      },
    });

    const results = await refreshRecurring(db, api, { now: () => NOW });

    expect(results[0]?.needsReauth).toBe(true);
    expect(results[0]?.needsConsent).toBeUndefined();
  });

  it('drops streams for accounts that no longer exist rather than aborting', async () => {
    const db = seedDb();
    const api = fakeApi({
      getRecurringStreams: async () =>
        response({ outflow_streams: [stream('s_ghost', { account_id: 'acc_gone' })] }),
    });

    const results = await refreshRecurring(db, api, { now: () => NOW });

    expect(results[0]?.ok).toBe(true);
    expect(results[0]?.streams).toBe(0);
    expect(listRecurringStreamRows(db)).toEqual([]);
  });
});

describe('listRecurring', () => {
  function seedStreams(db: Db): void {
    replaceRecurringStreams(db, 'item_1', toRecurringRows(
      response({
        outflow_streams: [
          stream('s_netflix'),
          stream('s_dead', { is_active: false, status: 'TOMBSTONED' as never }),
          stream('s_weekly', { frequency: 'WEEKLY' as never }),
        ],
        inflow_streams: [stream('s_pay', { description: 'PAYROLL' })],
      }),
      'item_1',
      NOW,
    ));
  }

  it('returns everything by default', () => {
    const db = seedDb();
    seedStreams(db);

    expect(listRecurring(db, {}, () => NOW).streams).toHaveLength(4);
  });

  it('filters to active streams', () => {
    const db = seedDb();
    seedStreams(db);

    const ids = listRecurring(db, { activeOnly: true }, () => NOW).streams.map(s => s.stream_id);

    expect(ids).not.toContain('s_dead');
    expect(ids).toHaveLength(3);
  });

  it('filters by direction and by frequency, case-insensitively', () => {
    const db = seedDb();
    seedStreams(db);

    expect(listRecurring(db, { direction: 'inflow' }, () => NOW).streams.map(s => s.stream_id))
      .toEqual(['s_pay']);
    expect(listRecurring(db, { frequency: 'weekly' }, () => NOW).streams.map(s => s.stream_id))
      .toEqual(['s_weekly']);
  });

  it('reports staleness from the refresh time, not the transaction sync time', () => {
    const db = seedDb();
    seedStreams(db);

    const fresh = listRecurring(db, {}, () => NOW);
    const stale = listRecurring(db, {}, () => NOW + 25 * 3600 * 1000);

    expect(fresh.meta.stale).toBe(false);
    expect(stale.meta.stale).toBe(true);
  });

  it('reports stale with a null timestamp when nothing has been refreshed', () => {
    const db = seedDb();

    expect(listRecurring(db, {}, () => NOW).meta).toEqual({ last_synced_at: null, stale: true });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/recurring.test.ts`
Expected: FAIL — `src/core/recurring.ts` does not exist.

- [ ] **Step 3: Write `src/core/recurring.ts`**

```ts
import type { TransactionStream, TransactionsRecurringGetResponse } from 'plaid';
import {
  lastRecurringRefreshAt,
  listAccountIdsForItem,
  listItems,
  listRecurringStreamRows,
  replaceRecurringStreams,
  type Db,
  type RecurringStreamRow,
} from './db.js';
import { toCentsOrNull } from './money.js';
import {
  isConsentRequired,
  isReauthRequired,
  type LedgerPlaidApi,
} from './plaid-client.js';
import type { QueryMeta } from './queries.js';

const STALE_MS = 24 * 3600 * 1000;

const CONSENT_HINT =
  'This bank has not consented to recurring transactions. Run ' +
  '`ledger auth consent <item_id>` — it uses Link update mode, so it does not create a ' +
  'duplicate connection or consume an Item slot.';

function toRow(
  s: TransactionStream,
  itemId: string,
  direction: 'inflow' | 'outflow',
  refreshedAt: number,
): RecurringStreamRow {
  return {
    stream_id: s.stream_id,
    item_id: itemId,
    account_id: s.account_id,
    direction,
    description: s.description,
    merchant_name: s.merchant_name,
    category_primary: s.personal_finance_category?.primary ?? null,
    category_detailed: s.personal_finance_category?.detailed ?? null,
    frequency: String(s.frequency),
    status: String(s.status),
    // SQLite has no boolean type.
    is_active: s.is_active ? 1 : 0,
    first_date: s.first_date,
    last_date: s.last_date,
    predicted_next_date: s.predicted_next_date ?? null,
    // Plaid types both amounts as optional. Sign is left Plaid-native: positive
    // is money leaving the account, so an outflow stream reads positive.
    average_amount_cents: toCentsOrNull(s.average_amount.amount),
    last_amount_cents: toCentsOrNull(s.last_amount.amount),
    transaction_count: s.transaction_ids.length,
    refreshed_at: refreshedAt,
  };
}

/** Flattens Plaid's two stream arrays into rows, tagging each with its direction. */
export function toRecurringRows(
  response: TransactionsRecurringGetResponse,
  itemId: string,
  refreshedAt: number,
): RecurringStreamRow[] {
  return [
    ...response.outflow_streams.map(s => toRow(s, itemId, 'outflow', refreshedAt)),
    ...response.inflow_streams.map(s => toRow(s, itemId, 'inflow', refreshedAt)),
  ];
}

export interface RecurringRefreshResult {
  itemId: string;
  institution: string;
  ok: boolean;
  streams: number;
  removed: number;
  error?: string;
  needsReauth?: boolean | undefined;
  needsConsent?: boolean | undefined;
}

/**
 * Refetches recurring streams for every Item, or one.
 *
 * Per-Item failures are collected rather than thrown: one bank that needs
 * re-authentication must not hide the streams of every other bank. This mirrors
 * how `syncAll` reports.
 */
export async function refreshRecurring(
  db: Db,
  api: LedgerPlaidApi,
  opts: { itemId?: string | undefined; now?: (() => number) | undefined } = {},
): Promise<RecurringRefreshResult[]> {
  const now = opts.now ?? Date.now;
  const items = listItems(db).filter(i => opts.itemId === undefined || i.id === opts.itemId);
  const results: RecurringRefreshResult[] = [];

  for (const item of items) {
    try {
      const response = await api.getRecurringStreams(item.access_token);
      const rows = toRecurringRows(response, item.id, now());

      // A stream can name an account this Item no longer holds — Plaid keeps
      // history for closed accounts. Inserting it violates the foreign key and
      // would abort the whole snapshot, so drop it instead: one orphaned stream
      // must not cost the user every other stream on the bank.
      const known = new Set(listAccountIdsForItem(db, item.id));
      const insertable = rows.filter(r => known.has(r.account_id));

      const removed = replaceRecurringStreams(db, item.id, insertable);
      results.push({
        itemId: item.id,
        institution: item.institution,
        ok: true,
        streams: insertable.length,
        removed,
      });
    } catch (error) {
      const consent = isConsentRequired(error);
      results.push({
        itemId: item.id,
        institution: item.institution,
        ok: false,
        streams: 0,
        removed: 0,
        error: consent ? CONSENT_HINT : error instanceof Error ? error.message : String(error),
        // Undefined rather than false so the JSON stays quiet in the common case.
        needsReauth: isReauthRequired(error) ? true : undefined,
        needsConsent: consent ? true : undefined,
      });
    }
  }

  return results;
}

export interface RecurringFilters {
  direction?: 'inflow' | 'outflow' | undefined;
  /** Hide TOMBSTONED and other ended streams. */
  activeOnly?: boolean | undefined;
  frequency?: string | undefined;
}

/**
 * Reads stored streams. Staleness is measured against the recurring refresh
 * time, not the transaction sync time — the two advance independently, and
 * reporting a fresh transaction sync as a fresh stream snapshot would be a lie.
 */
export function listRecurring(
  db: Db,
  f: RecurringFilters = {},
  now: () => number = Date.now,
): { streams: RecurringStreamRow[]; meta: QueryMeta } {
  const all = listRecurringStreamRows(db);
  const streams = all.filter(s => {
    if (f.direction !== undefined && s.direction !== f.direction) return false;
    if (f.activeOnly === true && s.is_active !== 1) return false;
    if (f.frequency !== undefined && s.frequency.toUpperCase() !== f.frequency.toUpperCase()) {
      return false;
    }
    return true;
  });

  const refreshedAt = lastRecurringRefreshAt(db);
  const meta: QueryMeta =
    refreshedAt === null
      ? { last_synced_at: null, stale: true }
      : { last_synced_at: refreshedAt, stale: now() - refreshedAt > STALE_MS };

  return { streams, meta };
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run tests/recurring.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify the module loads and typechecks**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/recurring.ts tests/recurring.test.ts
git commit -m "feat(recurring): map, refresh, and query Plaid recurring streams

Snapshot replace per item, not merge: the endpoint has no cursor and no
removed list, so a stream absent from a response has ended."
```

---

### Task 4: Views for recurring streams

**Files:**
- Modify: `src/core/views.ts`
- Test: `tests/views.test.ts`

**Interfaces:**
- Consumes: `RecurringStreamRow` (Task 2), `QueryMeta`.
- Produces:
  ```ts
  export type RecurringStreamView = Omit<
    RecurringStreamRow, 'average_amount_cents' | 'last_amount_cents' | 'is_active'
  > & { average_amount: number | null; last_amount: number | null; is_active: boolean };

  export function recurringStreamView(row: RecurringStreamRow): RecurringStreamView;
  export function recurringResultView(result: {
    streams: RecurringStreamRow[]; meta: QueryMeta;
  }): { streams: RecurringStreamView[]; meta: QueryMeta };
  ```

- [ ] **Step 1: Write the failing test**

Add to `tests/views.test.ts`:

```ts
describe('recurringStreamView', () => {
  const row = {
    stream_id: 's1', item_id: 'item_1', account_id: 'acc_1', direction: 'outflow',
    description: 'NETFLIX', merchant_name: 'Netflix',
    category_primary: 'ENTERTAINMENT', category_detailed: 'ENTERTAINMENT_STREAMING',
    frequency: 'MONTHLY', status: 'MATURE', is_active: 1,
    first_date: '2026-01-15', last_date: '2026-08-15', predicted_next_date: '2026-09-15',
    average_amount_cents: 1599, last_amount_cents: 1799, transaction_count: 8,
    refreshed_at: 1000,
  };

  it('converts cents to dollars and the integer flag to a boolean', () => {
    const view = recurringStreamView(row);

    expect(view.average_amount).toBe(15.99);
    expect(view.last_amount).toBe(17.99);
    expect(view.is_active).toBe(true);
    expect('average_amount_cents' in view).toBe(false);
    expect('is_active' in view && typeof view.is_active).toBe('boolean');
  });

  it('keeps a null amount null rather than reporting zero', () => {
    const view = recurringStreamView({
      ...row, average_amount_cents: null, last_amount_cents: null,
    });

    expect(view.average_amount).toBeNull();
    expect(view.last_amount).toBeNull();
  });

  it('maps is_active 0 to false', () => {
    expect(recurringStreamView({ ...row, is_active: 0 }).is_active).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/views.test.ts -t recurringStreamView`
Expected: FAIL — `recurringStreamView` is not exported.

- [ ] **Step 3: Add the views**

In `src/core/views.ts`, extend the `db.js` type import to include `RecurringStreamRow`, then append:

```ts
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
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run tests/views.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/views.ts tests/views.test.ts
git commit -m "feat(views): recurring stream view — dollars out, real boolean for is_active"
```

---

### Task 5: `ledger recurring` and `ledger recurring refresh`

**Files:**
- Modify: `src/cli/index.ts`

**Interfaces:**
- Consumes: `listRecurring`, `refreshRecurring` (Task 3); `recurringResultView` (Task 4).
- Produces: no new exported types.

- [ ] **Step 1: Add the commands**

In `src/cli/index.ts`, add these imports:

```ts
import { listRecurring, refreshRecurring, type RecurringRefreshResult } from '../core/recurring.js';
import { recurringResultView } from '../core/views.js';
```

Add a printer beside `printSyncResults`:

```ts
const CONSENT_HINT =
  'One or more banks have not consented to recurring transactions.\n' +
  'Run `ledger auth consent` — Link update mode, so no duplicate connection and no\n' +
  'Item slot consumed.';

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
  if (results.some(r => r.needsConsent)) process.stderr.write(CONSENT_HINT + '\n');
  if (results.some(r => r.needsReauth)) {
    process.stderr.write(REAUTH_HINT + '\n');
    process.exitCode = EXIT_REAUTH;
  } else if (results.some(r => !r.ok)) {
    process.exitCode = EXIT_GENERAL;
  }
}
```

Register the commands after the `spending` registration:

```ts
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
        const result = recurringResultView(
          listRecurring(db, {
            direction: opts.direction as 'inflow' | 'outflow' | undefined,
            activeOnly: opts.active,
            frequency: opts.frequency,
          }),
        );

        if (json) {
          process.stdout.write(JSON.stringify(result, null, 2) + '\n');
          return;
        }
        if (result.streams.length === 0) {
          process.stdout.write(
            'No recurring streams stored. Run `ledger recurring refresh` to fetch them.\n',
          );
          return;
        }
        process.stdout.write(
          formatTable(
            result.streams.map(s => ({
              direction: s.direction,
              merchant: s.merchant_name ?? s.description,
              frequency: s.frequency,
              average: money(Math.abs(s.average_amount ?? 0)),
              next: s.predicted_next_date ?? '-',
              status: s.status,
              active: s.is_active ? 'yes' : 'no',
            })),
          ) + '\n',
        );
        if (result.meta.stale) {
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
```

`money()` receives `Math.abs(...)` because an outflow stream is stored positive and an inflow negative; the table reads as magnitudes, with `direction` carrying the sign information. The `--direction` value is validated by hand because commander does not constrain option values.

- [ ] **Step 2: Verify the wiring**

Run: `pnpm cli -- recurring --help`
Expected: the three options are listed and the `refresh` subcommand appears.

Run: `pnpm cli -- recurring`
Expected against a database with no streams: `No recurring streams stored. Run \`ledger recurring refresh\` to fetch them.`

Run: `pnpm cli -- recurring --direction sideways`
Expected: exits non-zero with `--direction must be "inflow" or "outflow", got "sideways"`.

- [ ] **Step 3: Run the suite**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/cli/index.ts
git commit -m "feat(cli): add ledger recurring and recurring refresh"
```

---

### Task 6: MCP `list_recurring` tool

**Files:**
- Modify: `src/mcp/server.ts`
- Test: `tests/mcp.test.ts`

**Interfaces:**
- Consumes: `listRecurring` (Task 3), `recurringResultView` (Task 4).
- Produces: an MCP tool named `list_recurring` with inputs `{ direction?, activeOnly?, frequency? }`.

- [ ] **Step 1: Write the failing test**

Add to `tests/mcp.test.ts`, matching how that suite already invokes tools:

```ts
describe('list_recurring', () => {
  it('returns stored streams as dollars with a real boolean flag', async () => {
    const db = seedDb();
    replaceRecurringStreams(db, 'item_1', [
      {
        stream_id: 's1', item_id: 'item_1', account_id: 'acc_1', direction: 'outflow',
        description: 'NETFLIX', merchant_name: 'Netflix',
        category_primary: 'ENTERTAINMENT', category_detailed: 'ENTERTAINMENT_STREAMING',
        frequency: 'MONTHLY', status: 'MATURE', is_active: 1,
        first_date: '2026-01-15', last_date: '2026-08-15',
        predicted_next_date: '2026-09-15',
        average_amount_cents: 1599, last_amount_cents: 1599,
        transaction_count: 8, refreshed_at: NOW,
      },
    ]);

    const result = await callTool(db, 'list_recurring', {});

    expect(result.streams[0].average_amount).toBe(15.99);
    expect(result.streams[0].is_active).toBe(true);
    expect(result.streams[0]).not.toHaveProperty('average_amount_cents');
  });

  it('honours the activeOnly filter', async () => {
    const db = seedDb();
    replaceRecurringStreams(db, 'item_1', [
      {
        stream_id: 's_dead', item_id: 'item_1', account_id: 'acc_1', direction: 'outflow',
        description: 'OLD GYM', merchant_name: 'Gym',
        category_primary: null, category_detailed: null,
        frequency: 'MONTHLY', status: 'TOMBSTONED', is_active: 0,
        first_date: '2025-01-01', last_date: '2026-02-01',
        predicted_next_date: null,
        average_amount_cents: 4000, last_amount_cents: 4000,
        transaction_count: 13, refreshed_at: NOW,
      },
    ]);

    const result = await callTool(db, 'list_recurring', { activeOnly: true });

    expect(result.streams).toEqual([]);
  });
});
```

Use whatever helper this suite already has for invoking a tool and parsing its JSON text content; `callTool` above is a placeholder for that existing helper's real name.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/mcp.test.ts -t list_recurring`
Expected: FAIL — no such tool is registered.

- [ ] **Step 3: Register the tool**

In `src/mcp/server.ts`, add the imports:

```ts
import { listRecurring } from '../core/recurring.js';
import { recurringResultView } from '../core/views.js';
```

Register after `spending_summary`:

```ts
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
```

- [ ] **Step 3b: Register `refresh_recurring`**

Register immediately after `list_recurring`:

```ts
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
        'If a result carries needsConsent, that bank has never consented to recurring ' +
        'transactions: report the error text to the user, which names the exact command ' +
        'they need to run. Do not retry — the fix requires a browser.',
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
```

Add `refreshRecurring` to the `../core/recurring.js` import.

This mirrors the `sync` tool exactly, and for the same reason. An earlier draft
withheld it, arguing that a consent failure needs a browser round-trip the model
cannot perform — but `sync` has that identical property with
`ITEM_LOGIN_REQUIRED` and is exposed anyway, returning guidance text instead of
hiding. Withholding only this one was inconsistent, and it stranded an
unattended agent with permanently stale streams and no way to act.

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run tests/mcp.test.ts && pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Update the README**

In the CLI block, after the `categories` line:

```
ledger recurring [filters]        recurring bills, subs, income (local)
ledger recurring refresh          refetch streams from Plaid
```

In the **MCP** section, add `list_recurring` and `refresh_recurring` to the tool
list and append:

```markdown
`list_recurring` reads the local stream cache; `refresh_recurring` refetches it
from the banks. A bank that has never consented to recurring transactions
returns an error naming the `ledger auth consent` command needed to fix it —
that step needs a browser and stays CLI-only.
```

Add a new top-level section before **State**:

```markdown
## Recurring streams

Plaid detects recurring transactions — subscriptions, bills, paychecks — across
institutions, which is not something this tool can reproduce locally from the
transactions table. `ledger recurring refresh` fetches them; `ledger recurring`
reads the local copy.

```
ledger recurring --active --direction outflow   # live subscriptions and bills
ledger recurring --direction inflow             # paychecks and other income
```

Each stream carries a frequency (WEEKLY through ANNUALLY), a status, an average
and last amount, and a `predicted_next_date` when Plaid can predict one.

Status is worth reading closely:

| Status | Meaning |
|---|---|
| `MATURE` | Established — at least three occurrences on a regular cadence |
| `EARLY_DETECTION` | Seen too few times to be sure. A new subscription looks like this |
| `TOMBSTONED` | Previously detected, then stopped arriving — the subscription appears to have ended |
| `UNKNOWN` | None of the above applied |

**The stream set is a snapshot, not a running total.** Each refresh replaces
every stream for a bank, because Plaid's endpoint returns a full picture with no
cursor and no removals list. A stream that vanishes between refreshes has ended.

Streams are recalculated by Plaid on its own schedule, so a newly linked account
may show none until the next periodic update or a `ledger sync --force`.
```

- [ ] **Step 6: Commit**

```bash
git add src/mcp/server.ts tests/mcp.test.ts README.md
git commit -m "feat(mcp): add list_recurring tool"
```

---

## Self-Review

**Spec coverage.** Feature 3 asks for `/transactions/recurring/get` per Item (Task 1), a `recurring_streams` table refreshed as a whole-snapshot replace (Tasks 2 and 3), `ledger recurring` (Task 5), and an MCP `list_recurring` tool (Task 6). Every field the spec names — frequency, status, `is_active`, `first_date`, `last_date`, `predicted_next_date`, `average_amount`, `last_amount`, category, transaction count — is a column in Task 2 and a view field in Task 4. Success criterion 5 is exercised by Task 5 Step 2 and by the `refreshRecurring` tests in Task 3.

**Placeholders.** None. Two steps depend on existing test-suite helpers whose exact names this plan cannot know (`stubSdk` in Task 1, the tool-invocation helper in Task 6); both say so explicitly and describe what to use instead of inventing a name.

**Type consistency.** `RecurringStreamRow` is defined once in Task 2 and consumed unchanged in Tasks 3, 4, and 6. `is_active` is `number` (0/1) in the row and `boolean` in the view — the conversion happens only in `recurringStreamView`, and the view type's `Omit` makes a missed field a compile error. `RecurringFilters` in Task 3 matches the MCP `inputSchema` in Task 6 field for field. `QueryMeta` is reused from `queries.ts` rather than redefined, so `recurring`'s staleness envelope matches every other read.

**Deliberate omissions.** No stream editing — Plaid deprecated it and `is_user_modified` is now always `false`. No `updated_datetime` column: `refreshed_at` records when *this tool* fetched, which is what staleness needs, and storing both invites disagreement.

**Reversed during review.** An earlier draft withheld `refresh_recurring` from MCP on the grounds that a consent failure needs a browser. `sync` has the same property with `ITEM_LOGIN_REQUIRED` and is exposed, returning guidance rather than hiding — so the exclusion was inconsistent, and it left an unattended agent with permanently stale streams. Both tools are now exposed and both report actionable errors.

**Ordering note.** Task 2's `removeItem` change is not optional. `recurring_streams` references both `items` and `accounts`, so without it `ledger item remove` aborts on a foreign key for any bank with stored streams.
