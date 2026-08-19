# Plaid Liabilities Implementation Plan

**Goal:** Store Plaid's Liabilities snapshot locally and expose it through `ledger liabilities`
and MCP `list_liabilities`, so the Hermes agent can analyse a mortgage — rate, term, escrow,
next payment, and remaining principal — after Rocket Mortgage is linked.

## Context

`ledger-local` answers "what did I spend." It cannot answer anything about debt. The
capability-expansion spec
(`docs/superpowers/specs/2026-08-18-plaid-capability-expansion.md:166-195`) already requested
and stored consent for `liabilities` at link time, then deliberately shipped no reader:
*"This feature builds no liabilities or investments reader. It only preserves the option
cheaply."* This plan is that reader.

Rocket Mortgage is **`ins_117288`**, with `liabilities=1`, `transactions=1`, `balance=1`
— verified directly against Plaid's published coverage CSV
(`https://plaid.com/documents/us_institution_coverage.csv`, generated 2026-08-12). It will
appear in the Link picker under the current hardcoded `products: [Transactions]`
(`src/core/plaid-client.ts:405`), so **no link-token change is needed.** An earlier concern
that mortgage servicers might be filtered out of Link is closed.

### What changed while planning, and why it matters

**Production is live.** The tool runs on the user's Mac Mini hosting the Hermes agent, with
real Items and live access tokens, at schema **v5**. The dev machine
(`Aarons-Work-Mac`) has only an empty sandbox database. This retires the repo's
"no migrations — bump the version and delete the database" policy, whose stated expiry
condition (`spec:82-86`) was exactly the first production link.

**Liabilities is free.** On the Plaid Trial plan — free production data, capped at 10 Items —
Liabilities is one of eight bundled products. It is a *subscription-class* product in Plaid's
billing model, but bundled at no cost here. An earlier draft of this plan built an
enrollment gate around that cost; it has been removed as unnecessary complexity.

**`/item/remove` does not free a Trial Item slot.** Item slots, not dollars, are the scarce
resource. Two code comments claim otherwise and are wrong — corrected in Task 6.

---

## Hard constraints

1. **No `SCHEMA_VERSION` bump ships without a migration path.** `applySchema`
   (`src/core/db.ts:278-313`) throws on any `user_version` mismatch, and every command routes
   through `withCtx` → `openDb` (`src/cli/index.ts:58-69`) — including `ledger item remove`.
   A bare bump bricks the Mac Mini's CLI, and the printed remedy destroys the access tokens.
   The agent cannot learn past this; there would be no working command to learn.
2. Money is `INTEGER` cents. **Percentages are `REAL` and never touch `toCents`.**
   `6.125` means 6.125%. A percentage column must not end in `_cents`.
3. Full account numbers are never stored. `accounts.mask` provides identification.
4. Tests never reach the network — the Plaid SDK is injected via `PlaidSdk`, and
   `LedgerPlaidApi` fakes are hand-written.
5. Every CLI command supports `--json`. CLI and MCP share `views.ts` so their numbers cannot
   drift. Cents never escape a view.
6. Exit codes: `0` ok, `1` general, `2` config, `3` needs re-authentication.

---

## Domain facts

Verified against the installed `plaid@45` `dist/api.d.ts` on 2026-08-19. Do not re-derive.

- `liabilitiesGet(req: { access_token, options?: { account_ids? } }) -> { data: LiabilitiesGetResponse }`.
- `LiabilitiesGetResponse = { accounts: AccountBase[], item: Item, liabilities: LiabilitiesObject, request_id }`.
- `LiabilitiesObject = { credit, mortgage, student }`, each `Array<T> | null` **and** possibly
  `[]`. Handle both — `?? []` at every access.
- **`MortgageLiability` has no balance field.** Remaining principal is
  `AccountBase.balances.current`, documented for `loan` accounts as *"the principal remaining
  on the loan"*, positive when owed. Any mortgage output must join.
- **`LiabilitiesGetResponse` carries `accounts` in the same payload.** This is the single most
  useful fact in the design: the rate and the principal come from one response, so they
  cannot be from different moments. It also removes the compromise `refreshRecurring` had to
  make (`src/core/recurring.ts:108-113`), where streams naming an unknown account are dropped.
- `MortgageLiability` is 20 members; only three are non-null: `account_id: string`,
  `interest_rate` (object), `property_address` (object). Their *members* are all nullable.
- **`CreditCardLiability` has exactly nine members and no `primary` field.** A `primary: string`
  visible in a naive grep belongs to `CreditCategory`, the interface immediately following at
  `api.d.ts:20153`. An earlier draft of this plan declared a `primary` column; it was wrong.
- `CreditCardLiability.aprs` is `Array<APR>`, **not** nullable — Plaid: *"if APR data is not
  available, this array will be empty."*
- `CreditCardLiability.account_id` is `string | null`. `MortgageLiability.account_id` is not.
- `AccountBalance.limit` is the credit limit. **The repo does not store it**
  (`src/core/db.ts:164-177`), so card utilisation is unanswerable today.
- **There is no `/liabilities/refresh`.** Plaid re-reads liabilities roughly once a day on its
  own schedule and it cannot be forced. `ledger sync --force` does not help.
- Errors, all HTTP 400: `NO_LIABILITY_ACCOUNTS` (a **normal** outcome — every checking-only
  bank returns it), `PRODUCTS_NOT_SUPPORTED` (institution cannot), `ADDITIONAL_CONSENT_REQUIRED`
  (**fixable** by `ledger auth consent` — the inverse of recurring), `PRODUCT_NOT_READY` (the
  first call fetches on demand and is slow; `#call` already polls it for 5 minutes),
  `NO_ACCOUNTS`.
- HELOC (`loan`/`home equity`) and auto loans are **not** covered by Plaid Liabilities.

---

## Scope

**Mortgage and credit cards. Student loans are cut.**

This reverses the earlier "all three" decision, on grounds that only became clear afterwards:
`StudentLoan` is 25 fields across four nested objects plus an array — roughly 30 columns of
mapper, view, CLI, MCP schema and tests for a product the user likely does not hold and which
cannot be exercised in sandbox. More decisively, **the migration runner from Task 1 makes it
additive later**: the reason to decide everything up front was that schema changes were free
only before linking, and that pressure is now gone. Adding `liability_student` later is one
migration entry.

Credit stays because it is spec-motivated (`spec:18`, *"Which card should I pay first? (no APR,
no due date)"*), because `LiabilityOverride` **can** fabricate credit data in sandbox so it is
genuinely testable, and because `accounts.limit_cents` — needed to finish that question — is a
one-line addition while the schema is already open.

To restore student loans, say so at approval and Task 3 gains a third table.

---

## File structure

| File | Change |
|---|---|
| `src/core/db.ts` | Migration runner; schema v6; `accounts.limit_cents`; `items.liabilities_refreshed_at`; three row types; `replaceLiabilities`; readers; `removeItem` cleanup |
| `src/core/plaid-client.ts` | `liabilitiesGet` on `PlaidSdk`; `getLiabilities` on `LedgerPlaidApi`/`PlaidClient`; `isNoLiabilityAccounts`, `isProductUnsupported`; slot-comment corrections |
| `src/core/liabilities.ts` | **Create** — `toLiabilityRows`, `refreshLiabilities`, `listLiabilities` |
| `src/core/sync.ts` | `toAccountUpsert` maps `balances.limit` |
| `src/core/views.ts` | `mortgageView`, `creditView`, `aprView`, `liabilitiesResultView` |
| `src/cli/index.ts` | `ledger liabilities [refresh]` |
| `src/mcp/server.ts` | `list_liabilities`, `refresh_liabilities`; sign paragraph on `list_accounts` |
| `tests/liabilities.test.ts` | **Create** |
| `tests/db.test.ts`, `views.test.ts`, `plaid-client.test.ts`, `mcp.test.ts`, `helpers.ts` | Modify |
| `README.md` | Liabilities section; CLI + MCP tables |

Model every file on the recurring-streams equivalents — `docs/superpowers/plans/2026-08-18-03-recurring-streams.md`
is the template for task structure, test style, and commit granularity.

---

## Task 1 — Additive migration runner (must land first)

**Files:** `src/core/db.ts`, `tests/db.test.ts`.

Replace the throw-on-mismatch path with a forward-only migration loop. Keep the existing
version-0 and version-too-new errors; only the "older build" branch changes.

```ts
/**
 * Forward-only additive migrations, applied in order from the database's
 * user_version up to SCHEMA_VERSION.
 *
 * The old policy — bump the version and tell the user to delete the database —
 * expired when the first production Item was linked. The database is now the
 * only copy of the access tokens, every command routes through openDb, and on
 * the Trial plan a removed Item does not return its slot. "Delete it and
 * re-link" is no longer a recoverable instruction.
 *
 * Additive only: ADD COLUMN and CREATE TABLE. A migration that rewrites data
 * needs its own reviewed path, not this loop.
 */
const MIGRATIONS: Record<number, readonly string[]> = {
  6: [
    'ALTER TABLE accounts ADD COLUMN limit_cents INTEGER',
    'ALTER TABLE items ADD COLUMN liabilities_refreshed_at INTEGER',
    /* CREATE TABLE liability_mortgage ... */
    /* CREATE TABLE liability_credit ... */
    /* CREATE TABLE liability_credit_apr ... */
    /* indexes */
  ],
};
```

Applied inside one `db.transaction`, bumping `user_version` at the end, so a failure part-way
leaves the database at its previous version rather than half-migrated.

Also fix `applySchema`'s version-0 message (`db.ts:302-312`), which currently tells the user to
delete a file holding live tokens without naming the cost. It must state that every bank has to
be re-linked and that Trial slots are not returned.

**Tests:** a v5 database created from the old schema migrates to v6 with all new tables and
columns present and **its rows intact**; a v6 database is a no-op; a failed migration leaves
`user_version` unchanged; a fresh database still stamps v6 directly from `SCHEMA`.

Commit alone, before any liabilities work. This is the task that protects the Mac Mini.

## Task 2 — Fetch liabilities from Plaid

**Files:** `src/core/plaid-client.ts`, `tests/plaid-client.test.ts`.

```ts
// PlaidSdk
liabilitiesGet(req: { access_token: string }): Promise<{ data: LiabilitiesGetResponse }>;
// LedgerPlaidApi
getLiabilities(accessToken: string): Promise<LiabilitiesGetResponse>;
// new exports
export function isNoLiabilityAccounts(error: unknown): boolean;  // NO_LIABILITY_ACCOUNTS
export function isProductUnsupported(error: unknown): boolean;   // PRODUCTS_NOT_SUPPORTED
```

`PlaidClient.getLiabilities` follows `getRecurringStreams` exactly, through `#call('/liabilities/get', …)`.
`options.account_ids` is deliberately not exposed — every caller wants the whole Item.

`isProductUnsupported` must be checked **before** `isConsentRequired`, which also matches
`PRODUCTS_NOT_SUPPORTED` for recurring's benefit (`plaid-client.ts:128-135`). Leave
`isConsentRequired` untouched so recurring is unaffected.

**Expected fallout:** `pnpm typecheck` fails at every `LedgerPlaidApi` stub —
`tests/mcp.test.ts:19`, `tests/sync.test.ts:64`, `tests/recurring.test.ts:44`,
`tests/link.test.ts`, `tests/items.test.ts`. Add `getLiabilities: unused as never` to each.

## Task 3 — Schema v6 tables and accessors

**Files:** `src/core/db.ts`, `src/core/sync.ts`, `tests/db.test.ts`, `tests/helpers.ts`.

`accounts` gains `limit_cents INTEGER`; `toAccountUpsert` (`sync.ts:104-118`) maps
`toCentsOrNull(a.balances.limit)`. `AccountRow`, `accountView`, and the `AccountView` `Omit`
list all follow — the `Omit` derivation makes a missed field a compile error.

`items` gains `liabilities_refreshed_at INTEGER`. Declare `ItemUpsert` as
`Omit<ItemRow, 'cursor' | 'liabilities_refreshed_at'>` so **no existing caller or test changes**.

Three tables, all `account_id TEXT PRIMARY KEY REFERENCES accounts(id)` plus
`item_id TEXT NOT NULL REFERENCES items(id)` and `refreshed_at INTEGER NOT NULL`:

- **`liability_mortgage`** — `interest_rate_percentage REAL`, `interest_rate_type TEXT`,
  `escrow_balance_cents`, `current_late_fee_cents`, `has_pmi INTEGER`,
  `has_prepayment_penalty INTEGER`, `last_payment_amount_cents`, `last_payment_date`,
  `loan_type_description`, `loan_term`, `maturity_date`, `next_monthly_payment_cents`,
  `next_payment_due_date`, `origination_date`, `origination_principal_amount_cents`,
  `past_due_amount_cents`, `property_{street,city,region,postal_code,country}`,
  `ytd_interest_paid_cents`, `ytd_principal_paid_cents`.
  **Excluded: `account_number`** — full loan account number, PII, no analytical use, and
  re-fetchable from a snapshot endpoint if ever needed.
- **`liability_credit`** — `is_overdue INTEGER`, `last_payment_amount_cents`,
  `last_payment_date`, `last_statement_issue_date`, `last_statement_balance_cents`,
  `minimum_payment_amount_cents`, `next_payment_due_date`, `purchase_apr_percentage REAL`
  (denormalised from `aprs`, mirroring how `counterparty_type` denormalises
  `counterparties[0].type`).
- **`liability_credit_apr`** — child table, `account_id`/`item_id` + `apr_type TEXT NOT NULL`,
  `apr_percentage REAL NOT NULL`, `balance_subject_to_apr_cents`, `interest_charge_amount_cents`.
  **No primary key**: `apr_type` `special` can legitimately repeat, so `(account_id, apr_type)`
  would silently drop the second promotional rate. Rows only arrive via delete-then-insert.

`aprs` gets a child table rather than a JSON blob because **it contains money**. The
`counterparties_json` precedent (`sync.ts:69-70`) is safe only because that array holds none;
a blob containing `"balance_subject_to_apr": 5000.0` breaks the integer-cents invariant in a
form no column name or type can catch.

```ts
export interface LiabilitySnapshot {
  mortgage: readonly MortgageLiabilityRow[];
  credit: readonly CreditLiabilityRow[];
  aprs: readonly CreditAprRow[];
}
/** Replaces every liability for the Item across all three tables and stamps
 *  items.liabilities_refreshed_at, in one transaction. Replace, never merge:
 *  the endpoint has no cursor and no removed list, so a card absent from a
 *  response has been closed. The empty snapshot is NOT a special case. */
export function replaceLiabilities(
  db: Db, itemId: string, snap: LiabilitySnapshot, refreshedAt: number,
): number;
export function listMortgageRows(db: Db): MortgageLiabilityRow[];
export function listCreditRows(db: Db): CreditLiabilityRow[];
export function listCreditAprRows(db: Db): CreditAprRow[];
export function lastLiabilitiesRefreshAt(db: Db): number | null;
```

Staleness is stamped **on the Item**, not derived from `MIN(refreshed_at)` over data rows.
Deriving it from rows — as `lastRecurringRefreshAt` does (`db.ts:751-757`) — makes a bank with
legitimately zero liabilities read as permanently stale, which is the *normal* state for most
banks. (That is a live latent bug in `ledger recurring`; out of scope, worth a follow-up.)

**`removeItem` must delete from all three tables before the accounts delete**
(`db.ts:455-457`, beside the existing `recurring_streams` line). Not optional: without it
`ledger item remove` aborts on a foreign key *after* `/item/remove` has already destroyed the
Item at Plaid (`items.ts:46-52`), stranding a permanently unsyncable row and a spent slot.

`tests/helpers.ts` gains an exported `addLoanAccount(db, id, over?)` helper. **Do not modify
`seedDb`** — `tests/mcp.test.ts` asserts its account count.

## Task 4 — `src/core/liabilities.ts`

```ts
export function toLiabilityRows(
  response: LiabilitiesGetResponse, itemId: string, refreshedAt: number,
  knownAccountIds: ReadonlySet<string>,
): { snapshot: LiabilitySnapshot; dropped: number };

export interface LiabilitiesRefreshResult {
  itemId: string; institution: string; ok: boolean;
  mortgages: number; credit: number; removed: number; dropped: number;
  /** Plaid answered NO_LIABILITY_ACCOUNTS. An outcome, not a failure. */
  noLiabilityAccounts?: boolean | undefined;
  error?: string;
  needsReauth?: boolean | undefined;
  needsConsent?: boolean | undefined;
  unsupported?: boolean | undefined;
}
export function refreshLiabilities(db, api, opts?): Promise<LiabilitiesRefreshResult[]>;
export function listLiabilities(db, f?, now?): LiabilitiesQueryResult;
```

Structured like `refreshRecurring` (`recurring.ts:87-140`) — per-Item try/catch, results
collected not thrown. Three departures, each load-bearing:

1. **Upsert `response.accounts` first**, via `toAccountUpsert` already exported from `sync.ts:99`.
   That supplies the mortgage's remaining principal from the same response as its rate, and
   guarantees a parent row so a mortgage account opened since the last `ledger sync` is stored
   rather than dropped on the foreign key. **Do not call `setAccountSynced`** — `/liabilities/get`
   returns Plaid's cached balances, not the forced live read `/accounts/balance/get` gives, so
   stamping would claim the transactions clock advanced when it did not.
2. **`isNoLiabilityAccounts` is checked first and is a success path** — `ok: true`,
   `noLiabilityAccounts: true`, zero counts. It still writes an **empty snapshot**, because a
   bank that closed its last card answers this way and returning early would keep the dead card
   forever.
3. **Optional-chain the non-null nested objects**: `m.interest_rate?.percentage ?? null`,
   `m.property_address?.city ?? null`. Plaid's generated types assert non-null on objects the
   wire does not guarantee, and a thin servicer omitting them would otherwise throw and abort
   the whole Item.

Rows whose `account_id` is null or unknown are dropped **and counted** into `dropped`, never
silently — a vanished credit card in a "which card should I pay first" answer is not tolerable.

Hints, which are the inverse of recurring's:

```ts
const CONSENT_HINT =
  'Plaid says this bank has not consented to Liabilities. Unlike recurring transactions, ' +
  'this one IS grantable per Item: run `ledger auth consent <item_id>`, which uses Link ' +
  'update mode — it keeps the connection, the cursor, and the Item slot.';
const UNSUPPORTED_HINT =
  'This institution does not support Liabilities. Consent will not help and there is ' +
  'nothing to retry — Plaid coverage varies by bank.';
```

## Task 5 — Views, CLI, MCP

**Views.** `Omit`-derived as everywhere else, so a new `_cents` column that misses the
conversion is a compile error. `has_pmi: row.has_pmi === null ? null : row.has_pmi === 1` —
three-state; `=== 1` alone would report unreported PMI as "no PMI." Percentages pass through
untouched by construction. `mortgageView` joins `institution`, `account_name`, `account_mask`,
and **`outstanding_principal`** from `accounts`.

**Derive nothing else.** A view assembles data that exists; it does not compute data that does
not. Specifically excluded, with the reason going into the MCP description instead of the
payload: total paid to date (needs full payment history against a 730-day ceiling; the only
computable version — origination minus outstanding — is *principal reduction* and excludes
interest, which on a mortgage is most of what was paid), equity (needs market value Plaid never
has), remaining term (`maturity_date` is already there), payoff projections (an amortisation
model, not a view).

**CLI.** `ledger liabilities [--kind mortgage|credit] [--account <id>]` and
`ledger liabilities refresh [--item <id>]`, mirroring `ledger recurring` (`cli/index.ts:569-632`),
including the human table rendering raw cents through `money()` while `--json` goes through the
view. Rate renders as `` `${r.toFixed(3)}%` `` — never through `money()`.
`noLiabilityAccounts` rows print `ok: yes` with a `no liability accounts` note and **must not**
set `process.exitCode`; otherwise a healthy multi-bank run exits 1.

**MCP.** `list_liabilities({ kind?, accountId? })` and `refresh_liabilities({ itemId? })`.
Tool count 8 → 10; update the assertion at `tests/mcp.test.ts:61-74`. The description must carry:

- Mortgage balances are **joined**, not in Plaid's liabilities payload; if null, say so rather
  than deriving one from `origination_principal_amount`.
- Every `*_percentage` is a percentage, not money: `6.125` means 6.125%.
- Never report `origination_principal_amount − outstanding_principal` as "amount paid" — that
  is principal reduction only.
- `escrow_balance` is a **balance held on your behalf**, never a payment amount; never add it
  to `next_monthly_payment` and never subtract it from principal.
- `next_monthly_payment` is the servicer's stated next payment and is not guaranteed to include
  escrow, taxes, or insurance — not "total housing cost."
- `ytd_*` are **calendar-year-to-date as of `refreshed_at`**, reset each January, not lifetime
  totals. Lifetime interest paid is not available from Plaid at all.
- `loan_term` and `loan_type_description` are unenumerated free text from the servicer
  (`"30 year"`, `"360 months"`) — display only, never parsed. `maturity_date` is the
  machine-readable payoff date.
- `NO_LIABILITY_ACCOUNTS` returns `ok: true` and is normal for checking-only banks — not an
  error, do not retry, do not mention unless asked about that bank.
- Plaid re-reads liabilities about once a day and it cannot be forced, so a stale figure stays
  stale until tomorrow — say so rather than retrying.

Also add the missing **sign paragraph to `list_accounts`** (`server.ts:57-73`): for `loan` and
`credit` accounts a positive `current_balance` is money **owed** — subtract it, never add it.
Without this an agent computing net worth adds a $300k mortgage as an asset. And correct
`tests/helpers.ts`, which seeds a credit card at `current_balance_cents: -20_000`, contradicting
Plaid's documented sign.

## Task 6 — Correct the Item-slot comments

`src/core/plaid-client.ts:205` (*"freeing its slot"*) and `:438` (*"the Item's slot is freed"*)
are wrong. On the Trial plan `/item/remove` does **not** return a slot; only upgrading to a paid
plan raises the cap. `README.md:45` already has this right. Anyone reading those comments would
conclude a botched link is recoverable by remove-and-relink, when it in fact burns two of ten
slots permanently. Fix both, and check `src/mcp/server.ts:39` reads consistently.

## Task 7 — README

A `## Liabilities` section mirroring `## Recurring streams` (`README.md:248-277`): the two kinds
covered, that mortgage balance comes from the account rather than the liabilities payload, that
percentages are percentages, that `NO_LIABILITY_ACCOUNTS` is normal, that there is no forced
refresh, and that HELOC and auto loans are not covered. Plus the CLI block and the MCP tool list.

---

## Verification

**Verifiable before Rocket is linked** — these gate the merge:

1. `pnpm test && pnpm typecheck` pass at every task boundary.
2. A v5 database migrates to v6 with rows intact; a v6 database is a no-op.
3. **The all-null mortgage round-trips** — every nullable member null, `interest_rate` and
   `property_address` absent entirely (cast through `as unknown as MortgageLiability`). This is
   the *primary* fixture, not an edge case: it is the shape a thin servicer actually sends.
4. `liabilities: {credit: null, mortgage: null}` and `{credit: [], mortgage: []}` both yield an
   empty snapshot without throwing.
5. `NO_LIABILITY_ACCOUNTS` → `ok: true`, exit 0, and previously stored rows for that Item are
   deleted.
6. `ADDITIONAL_CONSENT_REQUIRED` → error names `ledger auth consent`;
   `PRODUCTS_NOT_SUPPORTED` → `unsupported: true` and does **not**.
7. A credit card with four APR types yields four child rows and the right
   `purchase_apr_percentage`; two `special` rates both persist.
8. `ledger item remove` succeeds on an Item holding liabilities.
9. A refreshed Item with zero liabilities reads `stale: false`, not permanently stale.
10. Sandbox smoke run: `ledger liabilities refresh` against `ins_109508` with a `credit`
    `LiabilityOverride`, proving the wiring end to end.

**Not verifiable until Rocket is linked** — none of these gate the merge, and no claim about
them belongs in the README until observed:

- Whether `/liabilities/get` succeeds on an Item created with `products: [transactions]` plus
  `additional_consented_products: [liabilities]`. This is Plan 02's central premise and has
  never been exercised. If it fails, `ledger auth consent` becomes a required setup step — a
  README change, not a code change.
- Which of the 20 `MortgageLiability` fields Rocket actually populates. The coverage CSV's
  `liabilities=1` is an institution-level capability flag, not a data-quality guarantee.
- The observed sign of `current_balance` on the mortgage account. **The view must never apply
  sign math to "fix" it** — views convert scale, never sign (`views.ts:53-54`).
- Real first-call latency under `PRODUCT_NOT_READY` polling.

Plaid Sandbox **cannot** fabricate mortgage data at all — `LiabilityOverride.type` accepts only
`credit` and `student` (*"Mortgages are not currently supported in the custom Sandbox"*). Hand-built
fixtures through the `LedgerPlaidApi` seam are the only mortgage coverage that exists pre-production.

## Deployment note

Task 1 must reach the Mac Mini before or with the schema bump. Confirm after deploying:

```bash
sqlite3 "${LEDGER_DATA_DIR:-$HOME/.local/share/ledger}/ledger.db" 'PRAGMA user_version;'   # 6
ledger auth status                                                                          # unchanged
```
