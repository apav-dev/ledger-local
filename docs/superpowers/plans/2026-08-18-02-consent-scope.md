# Consent Scope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Request consent for `liabilities`, `investments`, `recurring_transactions`, and `transactions_refresh` at link time — free until used — and add `ledger auth consent` to bring already-linked Items up to the same set through Link update mode.

**Architecture:** Add `additionalConsentedProducts` to `CreateLinkTokenOpts` and pass it in both new-Item and update-mode branches of `createLinkToken`. Add `upgradeConsent` to `src/auth/link.ts`, reusing the existing update-mode polling path that `repairItem` already uses. Record the accepted set on the item row (schema v4, a plain `SCHEMA` edit — there is no migration code) so later features can give an actionable error instead of surfacing a raw Plaid rejection.

**Tech Stack:** TypeScript 7 (strict), better-sqlite3 12, plaid 45, vitest 4, commander 15.

**Spec:** `docs/superpowers/specs/2026-08-18-plaid-capability-expansion.md` (Feature 2)

**Depends on:** Plan 01 (schema v3; this plan bumps to v4).

## Global Constraints

- Node >= 22, ESM, `pnpm` only.
- TypeScript strict. `pnpm typecheck` covers `src` and `tests`.
- Tests never reach the network. The Plaid SDK is injected via `PlaidSdk` and stubbed.
- Reads never hit the Plaid API. `auth consent` is a write path and may.
- Every CLI command supports `--json` except `init`.
- Exit codes: `0` ok, `1` general, `2` config, `3` needs re-authentication.
- **No migration code.** Schema changes are `SCHEMA` edits plus a `SCHEMA_VERSION` bump; delete the sandbox database when the version changes. Legitimate only until the first production Item exists — see Plan 01.
- **This plan must land before any production bank is linked.**
- Consent must never be requested in a way that can *fail* a link. If Plaid rejects a product name, linking must still succeed with the accepted subset.

## Open risk this plan resolves

`Products` in `plaid@45` contains `recurring_transactions` and
`transactions_refresh`, but it is **unverified** whether Plaid accepts those two
inside `additional_consented_products` — some enum members are only valid in
certain request contexts. Task 1 probes sandbox and fixes the constant to the
accepted set before anything depends on it. Do not skip it and do not guess.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `scripts/probe-consent.ts` | One-shot sandbox probe for accepted product names | Create, then keep — it is the record of how the constant was chosen |
| `src/core/plaid-client.ts` | Plaid transport, retry policy, error classification | Modify — `additionalConsentedProducts`, `CONSENTED_PRODUCTS` |
| `src/core/db.ts` | Schema and row types | Modify — schema v4, `items.consented_products` |
| `src/auth/link.ts` | Link flows | Modify — plumb consent, add `upgradeConsent` |
| `src/core/queries.ts` | Read models | Modify — `authStatus` reports consent |
| `src/cli/index.ts` | Command surface | Modify — `ledger auth consent [itemId]` |
| `tests/plaid-client.test.ts`, `tests/link.test.ts`, `tests/db.test.ts`, `tests/queries.test.ts` | | Modify |
| `README.md` | | Modify |

---

### Task 1: Probe which product names Plaid accepts

Produces the evidence the rest of the plan depends on. Requires a working sandbox `config.json`; it makes one real API call to Plaid's sandbox host and writes nothing to the database.

**Files:**
- Create: `scripts/probe-consent.ts`

**Interfaces:**
- Consumes: `loadConfig` from `src/core/config.ts`, `sdkFromConfig` from `src/core/plaid-client.ts`.
- Produces: a printed list of accepted product names. Task 2's `CONSENTED_PRODUCTS` constant must contain exactly the accepted set.

- [ ] **Step 1: Write the probe**

Create `scripts/probe-consent.ts`:

```ts
/**
 * One-shot sandbox probe: which Products does Plaid accept inside
 * `additional_consented_products`?
 *
 * The SDK's `Products` enum is shared across every request shape, so membership
 * in it does not prove a name is valid here. This asks Plaid directly, one
 * product at a time, so a single rejection cannot mask the others.
 *
 * Run: pnpm tsx scripts/probe-consent.ts
 * Requires a sandbox config.json. Makes one /link/token/create call per
 * candidate. Writes nothing.
 */
import { CountryCode, Products } from 'plaid';
import { loadConfig } from '../src/core/config.js';
import { sdkFromConfig, toPlaidApiError } from '../src/core/plaid-client.js';

const CANDIDATES: readonly Products[] = [
  Products.Liabilities,
  Products.Investments,
  Products.RecurringTransactions,
  Products.TransactionsRefresh,
];

async function main(): Promise<void> {
  const cfg = loadConfig();
  if (cfg.environment !== 'sandbox') {
    throw new Error(
      `Refusing to probe against ${cfg.environment}. Point LEDGER_CONFIG_DIR at a sandbox config.`,
    );
  }
  const sdk = sdkFromConfig(cfg);
  const accepted: Products[] = [];
  const rejected: Array<{ product: Products; reason: string }> = [];

  for (const product of CANDIDATES) {
    try {
      await sdk.linkTokenCreate({
        client_name: 'ledger-local-probe',
        language: 'en',
        country_codes: [CountryCode.Us],
        user: { client_user_id: 'ledger-local-probe' },
        products: [Products.Transactions],
        additional_consented_products: [product],
        hosted_link: {},
      });
      accepted.push(product);
    } catch (cause) {
      rejected.push({ product, reason: toPlaidApiError(cause, '/link/token/create').message });
    }
  }

  process.stdout.write(`accepted: ${accepted.join(', ') || '(none)'}\n`);
  for (const r of rejected) process.stdout.write(`rejected: ${r.product} — ${r.reason}\n`);
  process.stdout.write(
    `\nCopy the accepted list into CONSENTED_PRODUCTS in src/core/plaid-client.ts.\n`,
  );
}

await main();
```

- [ ] **Step 2: Run the probe**

Run: `pnpm tsx scripts/probe-consent.ts`
Expected: a line naming each accepted product, and a `rejected:` line with Plaid's own error text for any that are not.

If the run fails before the loop (bad credentials, no sandbox config), fix that first — a probe that never reached Plaid proves nothing, and an empty `accepted` list from a failed setup must not be mistaken for a real answer.

- [ ] **Step 3: Record the result**

Append the probe output verbatim to `docs/superpowers/specs/2026-08-18-plaid-capability-expansion.md`, under Feature 2, as:

```markdown
#### Probe result (sandbox, YYYY-MM-DD)

```
<paste the exact probe output here>
```
```

This is the answer to the spec's open risk. Later readers must not have to re-run it.

- [ ] **Step 4: Commit**

```bash
git add scripts/probe-consent.ts docs/superpowers/specs/2026-08-18-plaid-capability-expansion.md
git commit -m "chore: probe which products Plaid accepts as additional_consented_products"
```

---

### Task 2: Pass consent through the Plaid client

**Files:**
- Modify: `src/core/plaid-client.ts:130-146` (`CreateLinkTokenOpts`), `:311-334` (`createLinkToken`)
- Test: `tests/plaid-client.test.ts`

**Interfaces:**
- Consumes: the accepted product list from Task 1.
- Produces:
  ```ts
  export const CONSENTED_PRODUCTS: readonly Products[];
  export interface CreateLinkTokenOpts {
    accessToken?: string | undefined;
    redirectUri?: string | undefined;
    daysRequested?: number | undefined;
    additionalConsentedProducts?: readonly Products[] | undefined;
  }
  ```
  `LedgerPlaidApi.createLinkToken` keeps its signature; only the options widen.

- [ ] **Step 1: Write the failing tests**

Add to `tests/plaid-client.test.ts`:

```ts
describe('additional_consented_products', () => {
  it('sends the consent list when creating a new Item', async () => {
    const calls: LinkTokenCreateRequest[] = [];
    const client = new PlaidClient(CFG, {
      sdk: stubSdk({
        linkTokenCreate: async req => {
          calls.push(req);
          return { data: { link_token: 'lt', hosted_link_url: 'https://h', request_id: 'r' } };
        },
      }),
    });

    await client.createLinkToken({ additionalConsentedProducts: CONSENTED_PRODUCTS });

    expect(calls[0]?.additional_consented_products).toEqual([...CONSENTED_PRODUCTS]);
    expect(calls[0]?.products).toEqual(['transactions']);
  });

  it('sends the consent list in update mode, without products', async () => {
    const calls: LinkTokenCreateRequest[] = [];
    const client = new PlaidClient(CFG, {
      sdk: stubSdk({
        linkTokenCreate: async req => {
          calls.push(req);
          return { data: { link_token: 'lt', hosted_link_url: 'https://h', request_id: 'r' } };
        },
      }),
    });

    await client.createLinkToken({
      accessToken: 'access-sandbox-tok',
      additionalConsentedProducts: CONSENTED_PRODUCTS,
    });

    expect(calls[0]?.access_token).toBe('access-sandbox-tok');
    expect(calls[0]?.additional_consented_products).toEqual([...CONSENTED_PRODUCTS]);
    // Update mode must not resend products: the Item's product set and its
    // history depth are already fixed.
    expect(calls[0]?.products).toBeUndefined();
    expect(calls[0]?.transactions).toBeUndefined();
  });

  it('omits the field entirely when no consent list is given', async () => {
    const calls: LinkTokenCreateRequest[] = [];
    const client = new PlaidClient(CFG, {
      sdk: stubSdk({
        linkTokenCreate: async req => {
          calls.push(req);
          return { data: { link_token: 'lt', hosted_link_url: 'https://h', request_id: 'r' } };
        },
      }),
    });

    await client.createLinkToken({});

    expect('additional_consented_products' in (calls[0] ?? {})).toBe(false);
  });
});
```

Import `CONSENTED_PRODUCTS` and `type LinkTokenCreateRequest` at the top of the file. `CFG` and `stubSdk` are the existing helpers in this suite; if `stubSdk` does not yet accept partial overrides, extend it rather than duplicating it.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/plaid-client.test.ts -t additional_consented_products`
Expected: FAIL — `CONSENTED_PRODUCTS` is not exported.

- [ ] **Step 3: Add the constant**

In `src/core/plaid-client.ts`, immediately after `MAX_DAYS_REQUESTED`, add — **using exactly the product list Task 1's probe accepted**:

```ts
/**
 * Products consented at link time but never billed until their endpoints are
 * called. Plaid: "These products will not be billed until you start using them
 * by calling the relevant endpoints."
 *
 * Consent is requested up front because obtaining it later means sending the
 * user back through Link in update mode — once per Item, in a browser. Update
 * mode keeps the access_token, item_id, cursor, and Item slot, so deferring is
 * cheap in money and expensive in interruptions. This costs nothing.
 *
 * This list is exactly what Plaid's sandbox accepted on probe; see
 * scripts/probe-consent.ts. Membership in the SDK's `Products` enum is not
 * evidence a name is valid here — the enum is shared across request shapes.
 */
export const CONSENTED_PRODUCTS: readonly Products[] = [
  Products.Liabilities,
  Products.Investments,
  Products.RecurringTransactions,
  Products.TransactionsRefresh,
];
```

If the probe rejected any of these, delete the rejected entries and note the rejection in a comment. Do not leave a rejected name in the array.

- [ ] **Step 4: Widen the options and the request**

Add to `CreateLinkTokenOpts`:

```ts
  /**
   * Consent to collect. Valid in both new-Item and update mode — update mode is
   * the supported way to add consent to an Item that already exists.
   */
  additionalConsentedProducts?: readonly Products[] | undefined;
```

In `createLinkToken`, replace the request object with:

```ts
      this.#api.linkTokenCreate({
        client_name: this.#clientName,
        language: 'en',
        country_codes: [CountryCode.Us],
        user: { client_user_id: 'ledger-local-user' },
        // Update mode reuses the existing Item; products must be omitted then.
        // So must `transactions`: the Item's history depth is already fixed, and
        // Plaid documents the field as having no effect once Transactions has
        // been added to an Item.
        ...(opts.accessToken === undefined
          ? {
              products: [Products.Transactions],
              transactions: { days_requested: opts.daysRequested ?? MAX_DAYS_REQUESTED },
            }
          : { access_token: opts.accessToken }),
        // Sent in BOTH branches. In update mode this is the entire point of the
        // call: it is how consent is added to an Item that already exists.
        ...(opts.additionalConsentedProducts === undefined
          ? {}
          : { additional_consented_products: [...opts.additionalConsentedProducts] }),
        ...(opts.redirectUri === undefined ? {} : { redirect_uri: opts.redirectUri }),
        hosted_link: {},
      }),
```

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run tests/plaid-client.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/plaid-client.ts tests/plaid-client.test.ts
git commit -m "feat(plaid): send additional_consented_products in new and update mode"
```

---

### Task 3: Schema v4 — record consent on the item

**Files:**
- Modify: `src/core/db.ts` — `SCHEMA`, `SCHEMA_VERSION`, `ItemRow`, `upsertItem`, new `setItemConsent`
- Test: `tests/db.test.ts`

**Interfaces:**
- Consumes: schema v3 from Plan 01 Task 1.
- Produces:
  ```ts
  interface ItemRow { /* existing fields */ consented_products: string | null }
  export function setItemConsent(db: Db, itemId: string, products: readonly string[]): void
  export function itemConsent(db: Db, itemId: string): string[]
  ```
  `ItemUpsert` stays `Omit<ItemRow, 'cursor'>` and therefore now also carries `consented_products`.

- [ ] **Step 1: Write the failing test**

Add to `tests/db.test.ts`:

```ts
describe('item consent', () => {
  it('round-trips a consent list', () => {
    const db = openDb(':memory:', 'sandbox');
    upsertItem(db, {
      id: 'item_1', access_token: 'tok', institution: 'Chase',
      institution_id: 'ins_56', created_at: 1, consented_products: null,
    });

    setItemConsent(db, 'item_1', ['liabilities', 'investments']);

    expect(itemConsent(db, 'item_1')).toEqual(['liabilities', 'investments']);
  });

  it('reports an empty list when consent was never recorded', () => {
    const db = openDb(':memory:', 'sandbox');
    upsertItem(db, {
      id: 'item_1', access_token: 'tok', institution: 'Chase',
      institution_id: 'ins_56', created_at: 1, consented_products: null,
    });

    expect(itemConsent(db, 'item_1')).toEqual([]);
  });

  it('does not reset consent when an item is re-upserted by update mode', () => {
    const db = openDb(':memory:', 'sandbox');
    const row = {
      id: 'item_1', access_token: 'tok', institution: 'Chase',
      institution_id: 'ins_56', created_at: 1, consented_products: null,
    };
    upsertItem(db, row);
    setItemConsent(db, 'item_1', ['liabilities']);

    upsertItem(db, { ...row, access_token: 'tok2' });

    expect(itemConsent(db, 'item_1')).toEqual(['liabilities']);
  });

  it('stamps a fresh database at version 4', () => {
    const db = openDb(':memory:', 'sandbox');

    expect(db.pragma('user_version', { simple: true })).toBe(4);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/db.test.ts -t "item consent"`
Expected: FAIL — `setItemConsent` is not exported.

- [ ] **Step 3: Add the column and bump the version**

In `src/core/db.ts`, add to the `items` `CREATE TABLE` inside `SCHEMA`, after `created_at`:

```sql
  consented_products TEXT
```

Bump the version so any sandbox database from the previous build is rejected rather than silently missing the column:

```ts
const SCHEMA_VERSION = 4;
```

Then delete your sandbox database — free now, not after the first production link:

```bash
rm -f ~/.local/share/ledger/ledger.db*
```

- [ ] **Step 4: Add the row field and accessors**

Add to `ItemRow`:

```ts
  /**
   * JSON array of Plaid product names consented for this Item, as accepted at
   * link or consent-upgrade time. NULL means never recorded.
   *
   * Plaid's /item/get is authoritative; this is a local record of what was
   * requested, kept so a feature can say "run `ledger auth consent`" instead of
   * surfacing a raw Plaid rejection. Treat a mismatch as this column being stale.
   */
  consented_products: string | null;
```

`upsertItem` must **not** overwrite it on conflict, for the same reason it leaves `cursor` alone: update mode re-upserts the row and must not erase what it just established. Change the `INSERT` to:

```ts
export function upsertItem(db: Db, row: ItemUpsert): void {
  db.prepare(
    `INSERT INTO items (id, access_token, institution, institution_id, cursor, created_at,
                        consented_products)
     VALUES (@id, @access_token, @institution, @institution_id, NULL, @created_at,
             @consented_products)
     ON CONFLICT(id) DO UPDATE SET
       access_token   = excluded.access_token,
       institution    = excluded.institution,
       institution_id = excluded.institution_id`,
  ).run(row);
}
```

Add below `setItemCursor`:

```ts
/** Records the consent set for an Item. Replaces any previous value. */
export function setItemConsent(db: Db, itemId: string, products: readonly string[]): void {
  db.prepare('UPDATE items SET consented_products = ? WHERE id = ?').run(
    JSON.stringify([...products]),
    itemId,
  );
}

/**
 * Consented products for an Item, or an empty list.
 *
 * Never throws on bad JSON. This column is advisory — it exists to improve an
 * error message — so a corrupt value must degrade to "unknown", not break a
 * command that would otherwise work.
 */
export function itemConsent(db: Db, itemId: string): string[] {
  const row = db.prepare('SELECT consented_products FROM items WHERE id = ?').get(itemId) as
    | { consented_products: string | null }
    | undefined;
  if (row?.consented_products == null) return [];
  try {
    const parsed: unknown = JSON.parse(row.consented_products);
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}
```

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run tests/db.test.ts`
Expected: PASS for the consent block. Other suites now fail to typecheck because `ItemUpsert` literals lack `consented_products`.

- [ ] **Step 6: Fix the literals**

Run: `pnpm typecheck`
Add `consented_products: null` to every `upsertItem` literal it names — `tests/helpers.ts`, `tests/sync.test.ts`, `tests/link.test.ts`, `tests/items.test.ts`. In `src/auth/link.ts`'s `linkNewItem`, add `consented_products: null` for now; Task 4 replaces it.

- [ ] **Step 7: Run the suite**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/core/db.ts tests/
git commit -m "feat(db): schema v4 — record consented products per item"
```

---

### Task 4: Request consent at link time, and add `upgradeConsent`

**Files:**
- Modify: `src/auth/link.ts` — `LinkRunOpts`, `openHostedLinkAndWait`, `linkNewItem`, new `upgradeConsent`
- Test: `tests/link.test.ts`

**Interfaces:**
- Consumes: `CONSENTED_PRODUCTS` (Task 2), `setItemConsent` (Task 3).
- Produces:
  ```ts
  export async function upgradeConsent(
    db: Db, api: LedgerPlaidApi, itemId: string, opts: LinkRunOpts,
  ): Promise<{ itemId: string; institution: string; consented: string[] }>
  ```
  `linkNewItem` and `repairItem` keep their existing signatures and return types.

- [ ] **Step 1: Write the failing tests**

Add to `tests/link.test.ts`:

```ts
describe('consent', () => {
  it('requests the consent set when linking a new item, and records it', async () => {
    const db = openDb(':memory:', 'sandbox');
    const seen: CreateLinkTokenOpts[] = [];
    const api = fakeApi({
      createLinkToken: async opts => {
        seen.push(opts);
        return { linkToken: 'lt', hostedLinkUrl: 'https://hosted' };
      },
    });

    await linkNewItem(db, api, { openUrl: () => {}, sleep: async () => {}, now: () => 0 });

    expect(seen[0]?.additionalConsentedProducts).toEqual([...CONSENTED_PRODUCTS]);
    expect(itemConsent(db, 'item_new')).toEqual([...CONSENTED_PRODUCTS]);
  });

  it('upgrades consent on an existing item through update mode', async () => {
    const db = openDb(':memory:', 'sandbox');
    upsertItem(db, {
      id: 'item_1', access_token: 'access-tok', institution: 'Chase',
      institution_id: 'ins_56', created_at: 1, consented_products: null,
    });
    setItemCursor(db, 'item_1', 'cursor_keep');
    const seen: CreateLinkTokenOpts[] = [];
    const api = fakeApi({
      createLinkToken: async opts => {
        seen.push(opts);
        return { linkToken: 'lt', hostedLinkUrl: 'https://hosted' };
      },
      // Update mode finishes without minting a public_token.
      getLinkSession: async () => ({
        link_sessions: [{ link_token: 'lt', finished_at: '2026-08-18T00:00:00Z' }],
        request_id: 'r',
      }) as never,
    });

    const result = await upgradeConsent(db, api, 'item_1', {
      openUrl: () => {}, sleep: async () => {}, now: () => 0,
    });

    expect(seen[0]?.accessToken).toBe('access-tok');
    expect(seen[0]?.additionalConsentedProducts).toEqual([...CONSENTED_PRODUCTS]);
    expect(result.consented).toEqual([...CONSENTED_PRODUCTS]);
    expect(itemConsent(db, 'item_1')).toEqual([...CONSENTED_PRODUCTS]);
    // Update mode must not disturb sync progress.
    expect(getItem(db, 'item_1')?.cursor).toBe('cursor_keep');
  });

  it('refuses to upgrade consent for an unknown item', async () => {
    const db = openDb(':memory:', 'sandbox');

    await expect(
      upgradeConsent(db, fakeApi({}), 'nope', { openUrl: () => {}, sleep: async () => {}, now: () => 0 }),
    ).rejects.toThrow(/No linked item with id "nope"/);
  });

  it('leaves consent unrecorded when the link session fails', async () => {
    const db = openDb(':memory:', 'sandbox');
    upsertItem(db, {
      id: 'item_1', access_token: 'access-tok', institution: 'Chase',
      institution_id: 'ins_56', created_at: 1, consented_products: null,
    });
    const api = fakeApi({
      createLinkToken: async () => ({ linkToken: 'lt', hostedLinkUrl: 'https://hosted' }),
      getLinkSession: async () => ({
        link_sessions: [{
          link_token: 'lt',
          exit: { error: { error_code: 'USER_EXIT', error_message: 'closed' } },
        }],
        request_id: 'r',
      }) as never,
    });

    await expect(
      upgradeConsent(db, api, 'item_1', { openUrl: () => {}, sleep: async () => {}, now: () => 0 }),
    ).rejects.toThrow(LinkError);
    expect(itemConsent(db, 'item_1')).toEqual([]);
  });
});
```

`fakeApi` is this suite's existing `LedgerPlaidApi` stub factory; extend it to accept partial overrides if it does not already. The new-item test assumes the existing stub exchanges a public token into `item_new` — match whatever id the suite's default stub returns.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/link.test.ts -t consent`
Expected: FAIL — `upgradeConsent` is not exported.

- [ ] **Step 3: Plumb consent through the shared link path**

In `src/auth/link.ts`, add to `LinkRunOpts`:

```ts
  /**
   * Consent to request. Defaults to CONSENTED_PRODUCTS. Present as an option
   * only so tests can assert on the empty case.
   */
  consentedProducts?: readonly Products[] | undefined;
```

Import at the top:

```ts
import type { Products } from 'plaid';
import { CONSENTED_PRODUCTS, type LedgerPlaidApi } from '../core/plaid-client.js';
import { getItem, setItemConsent, upsertItem, type Db } from '../core/db.js';
```

In `openHostedLinkAndWait`, change the `createLinkToken` call to:

```ts
  const { linkToken, hostedLinkUrl } = await api.createLinkToken({
    accessToken: opts.accessToken,
    redirectUri: opts.redirectUri,
    additionalConsentedProducts: opts.consentedProducts ?? CONSENTED_PRODUCTS,
  });
```

- [ ] **Step 4: Record consent in `linkNewItem`**

In `linkNewItem`, replace the `upsertItem` call and add the consent write:

```ts
  const consented = opts.consentedProducts ?? CONSENTED_PRODUCTS;

  upsertItem(db, {
    id: itemId,
    access_token: accessToken,
    institution,
    institution_id: terminal.institutionId,
    created_at: Date.now(),
    consented_products: null,
  });
  // Written after the upsert, not inside it: upsertItem deliberately preserves
  // cursor and consent on conflict, so a fresh row needs the value set
  // explicitly. Recorded only once Plaid has accepted the link.
  setItemConsent(db, itemId, [...consented]);
```

- [ ] **Step 5: Add `upgradeConsent`**

Append to `src/auth/link.ts`:

```ts
export interface ConsentUpgrade extends LinkedItem {
  consented: string[];
}

/**
 * Brings an already-linked Item up to the current consent set through Link
 * update mode.
 *
 * Plaid: "To collect a user's consent for additional products on an existing
 * Item via the additional_consented_products field of /link/token/create, send
 * the user through update mode." Update mode keeps the access_token, the
 * item_id, and the transactions cursor, and consumes no Item slot — so this is
 * a browser round-trip, not a re-link.
 *
 * Consent is recorded only after the session reaches a terminal state without
 * error. A cancelled session must leave the row untouched, or the local record
 * would claim consent the user never gave.
 */
export async function upgradeConsent(
  db: Db,
  api: LedgerPlaidApi,
  itemId: string,
  opts: LinkRunOpts,
): Promise<ConsentUpgrade> {
  const item = getItem(db, itemId);
  if (item === undefined) {
    throw new LinkError(
      `No linked item with id "${itemId}". Run \`ledger auth status\` to list them.`,
    );
  }

  const consented = [...(opts.consentedProducts ?? CONSENTED_PRODUCTS)];
  await openHostedLinkAndWait(api, { ...opts, accessToken: item.access_token });
  setItemConsent(db, itemId, consented);

  return { itemId: item.id, institution: item.institution, consented };
}
```

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run tests/link.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/auth/link.ts tests/link.test.ts
git commit -m "feat(auth): request consent at link time, add upgradeConsent via update mode"
```

---

### Task 5: `ledger auth consent` and consent in `auth status`

**Files:**
- Modify: `src/cli/index.ts` — new subcommand under `auth`
- Modify: `src/core/queries.ts:188-225` (`authStatus`, `AuthStatusItem`)
- Test: `tests/queries.test.ts`

**Interfaces:**
- Consumes: `upgradeConsent` (Task 4), `itemConsent` (Task 3), `CONSENTED_PRODUCTS` (Task 2).
- Produces:
  ```ts
  export interface AuthStatusItem {
    id: string; institution: string; accountCount: number; synced: boolean;
    consented: string[];
    consentUpToDate: boolean;
  }
  ```

- [ ] **Step 1: Write the failing test**

Add to `tests/queries.test.ts`:

```ts
describe('authStatus consent', () => {
  it('reports consent as out of date when the item predates the current set', () => {
    const db = seedDb();

    const status = authStatus(db, { environment: 'sandbox' });

    expect(status.items[0]?.consented).toEqual([]);
    expect(status.items[0]?.consentUpToDate).toBe(false);
  });

  it('reports consent as up to date once every current product is recorded', () => {
    const db = seedDb();
    setItemConsent(db, 'item_1', [...CONSENTED_PRODUCTS]);

    const status = authStatus(db, { environment: 'sandbox' });

    expect(status.items[0]?.consentUpToDate).toBe(true);
  });

  it('treats a superset as up to date', () => {
    const db = seedDb();
    setItemConsent(db, 'item_1', [...CONSENTED_PRODUCTS, 'auth']);

    const status = authStatus(db, { environment: 'sandbox' });

    expect(status.items[0]?.consentUpToDate).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/queries.test.ts -t "authStatus consent"`
Expected: FAIL — `consented` is not a property of the returned items.

- [ ] **Step 3: Extend `authStatus`**

In `src/core/queries.ts`, add the import:

```ts
import { itemConsent, listAccountRows, listItems, type AccountRow, type Db, type TransactionRow } from './db.js';
import { CONSENTED_PRODUCTS } from './plaid-client.js';
```

Extend the interface:

```ts
export interface AuthStatusItem {
  id: string;
  institution: string;
  accountCount: number;
  /** False until the first successful sync completes for this Item. */
  synced: boolean;
  /** Products consented for this Item, as recorded locally at link time. */
  consented: string[];
  /**
   * False when this Item lacks consent for a product the current build would
   * request. Adding it needs `ledger auth consent <item_id>` — an update-mode
   * browser round-trip, not a re-link.
   */
  consentUpToDate: boolean;
}
```

Replace the returned mapping:

```ts
  return {
    environment: cfg.environment,
    items: rows.map(r => {
      const consented = itemConsent(db, r.id);
      return {
        id: r.id,
        institution: r.institution,
        accountCount: r.accountCount,
        synced: r.cursor !== null,
        consented,
        // Superset counts as current: an Item consented for more than this build
        // asks for is not out of date.
        consentUpToDate: CONSENTED_PRODUCTS.every(p => consented.includes(String(p))),
      };
    }),
  };
```

- [ ] **Step 4: Run the test**

Run: `pnpm vitest run tests/queries.test.ts -t "authStatus consent"`
Expected: PASS.

- [ ] **Step 5: Add the CLI subcommand**

In `src/cli/index.ts`, import `upgradeConsent` alongside `linkNewItem` and `repairItem`, import `CONSENTED_PRODUCTS`, and add after the `auth repair` registration:

```ts
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
```

The loop is sequential on purpose: each iteration opens a browser tab and waits for a human. Running them concurrently would open every tab at once.

- [ ] **Step 5b: Make the browser launcher portable**

`openInBrowser` shells out to `open`, which exists only on macOS:

```ts
function openInBrowser(url: string): void {
  // Detached so a slow browser launch cannot hold the CLI open.
  exec(`open ${JSON.stringify(url)}`);
}
```

The tool runs on a headless Linux box in at least one deployment, where this is
a silent no-op — `exec` is detached and its result unchecked, so nothing reports
the failure. It degrades tolerably because `link.ts` prints the hosted URL
before calling this, but `auth consent` may open several sessions in a row and a
launcher that quietly does nothing on half the platforms it runs on is worth ten
lines. Replace it with:

```ts
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
```

Verify on the host that will actually run this:

```bash
node -e "console.log(process.platform)"
```

`darwin` uses `open`, `linux` uses `xdg-open`, `win32` uses `start`.

- [ ] **Step 6: Show consent in `auth status`**

In the `auth status` action, replace the `formatTable` argument with:

```ts
            status.items.map(i => ({
              item_id: i.id,
              institution: i.institution,
              accounts: i.accountCount,
              synced: i.synced ? 'yes' : 'never',
              consent: i.consentUpToDate ? 'current' : 'needs upgrade',
            })),
```

and append after the table, before the closing `'\n'`:

```ts
          (status.items.some(i => !i.consentUpToDate)
            ? '\nSome banks predate the current product consent set. Run `ledger auth consent`\n' +
              'to grant it — update mode, so no duplicate Item and no slot consumed.\n'
            : '') +
```

- [ ] **Step 7: Verify the command wiring**

Run: `pnpm cli -- auth consent --help`
Expected: the description prints and the optional `[itemId]` argument is listed.

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 8: Update the README**

In the CLI block, after the `auth repair` line, add:

```
ledger auth consent [item_id]     grant full product consent (update mode)
```

Add a new section after **Use `auth repair`, not `auth`, to fix a broken connection**:

```markdown
### Product consent

Linking requests consent for `liabilities`, `investments`,
`recurring_transactions`, and `transactions_refresh` in addition to
`transactions`. Consent is free — Plaid bills a product only once you call its
endpoints — and it is requested up front so a future feature does not need a
browser trip per bank to turn on.

Banks linked before this became the default show `consent: needs upgrade` in
`ledger auth status`. Fix them with:

```
ledger auth consent            # every bank that needs it
ledger auth consent <item_id>  # just one
```

This uses Link **update mode**, which keeps the existing `access_token`,
`item_id`, and sync cursor and consumes **no** Item slot. It is a browser
round-trip, not a re-link.
```

- [ ] **Step 9: Commit**

```bash
git add src/cli/index.ts src/core/queries.ts tests/queries.test.ts README.md
git commit -m "feat(cli): add auth consent, surface consent state in auth status"
```

---

## Self-Review

**Spec coverage.** Feature 2 asks for consent at link time (Task 4), `ledger auth consent [itemId]` via update mode (Task 5), a local record of the consented set (Task 3), and resolution of the unverified product-name risk (Task 1). Success criterion 4 — consent upgrade without creating a second Item — is asserted in Task 4 Step 1, which also checks the cursor survives.

**Placeholders.** None. Task 1 Step 3 asks the implementer to paste real probe output, which is data that cannot exist before the step runs; the step states exactly where it goes and why.

**Type consistency.** `CONSENTED_PRODUCTS` is `readonly Products[]` throughout; every consumer spreads it into a mutable array at the call boundary, because `additional_consented_products` on `LinkTokenCreateRequest` is `Array<Products> | null`. `AuthStatusItem` gains `consented: string[]` and `consentUpToDate: boolean` in Task 5 and is consumed only by `src/cli/index.ts`. `consentUpToDate` compares with `String(p)` because `Products` is a string enum while `itemConsent` returns plain strings.

**Ordering note.** Task 3 must land before Task 4: `linkNewItem` calls `setItemConsent`, which does not exist until Task 3. Task 2 must land before both: `CONSENTED_PRODUCTS` is defined there.

**Deliberate omission.** No liabilities or investments reader is built. This plan only makes those cheap to add later, which is the whole point of doing it before production banks are linked.
