# Plaid Capability Expansion — Design Spec

**Date:** 2026-08-18
**Branch context:** follows `feat/plaid-migration`
**Status:** approved for planning

## Goal

Extend `ledger-local` to use four Plaid capabilities it currently pays for or
could enable at near-zero cost, chosen for what they let an AI agent answer that
it cannot answer today.

## Motivating gap

The current tool answers *"what did I spend, grouped how."* It cannot answer:

- "What am I subscribed to, and what's due before payday?"
- "Which card should I pay first?" (no APR, no due date)
- "What did I spend on Saturday?" (post date is stored, not purchase date)
- "How much of my spending is online?" (`payment_channel` is stored in a column
  named `type` and never surfaced)
- "Is that category right?" (no confidence signal)
- "Did my paycheck land?" (sync returns Plaid's last ingest, not a live pull)

## Verified API facts

These were checked against the Plaid docs and the installed `plaid@45` SDK types
on 2026-08-18. They constrain the design; do not re-derive them from memory.

| Fact | Source | Consequence |
|---|---|---|
| `additional_consented_products` is not billed until the product's endpoints are called | `/docs/api/link/` | Consent is free; request it broadly |
| Consent for new products can be added to an **existing** Item through Link **update mode** | `/docs/link/update-mode/` | Deferring consent costs one browser round-trip per Item — **not** a re-link |
| Update mode preserves `access_token`, `item_id`, and the transactions cursor, and consumes no new Item slot | `/docs/link/update-mode/` | `repairItem`'s existing code path is reusable for consent upgrades |
| `days_requested` cannot be raised after Transactions is added to an Item | `/docs/api/products/transactions/` | Already handled (`MAX_DAYS_REQUESTED = 730`); unchanged by this work |
| `Products` enum contains `recurring_transactions` and `transactions_refresh` as distinct members | `plaid@45` `api.d.ts:45585` | Features 3 and 4 may require their own consent — **must be verified in sandbox** |
| `/transactions/recurring/get` returns a full snapshot (`inflow_streams`, `outflow_streams`), with no cursor | `plaid@45` `TransactionsRecurringGetResponse` | Storage is replace-per-Item, not incremental |
| `TransactionStream.is_user_modified` is deprecated and always `false` | `plaid@45` `api.d.ts` | Do not build stream editing |
| Recurring streams are not recalculated for a new account until the next periodic update or a `/transactions/refresh` call | `/docs/api/products/transactions/` | Feature 4 is a precondition for freshness in feature 3 |
| Plaid pulls from institutions 1–4×/day on its own schedule | `/docs/api/products/transactions/` | `sync` alone can be hours stale with no signal |
| `/transactions/recurring/get` needs only `access_token`; `account_ids` is optional | `plaid@45` `TransactionsRecurringGetRequest` | One call per Item, no account enumeration |
| `/transactions/refresh` takes only `access_token` and returns only a `request_id` | `plaid@45` `TransactionsRefreshRequest` | It triggers a pull; data arrives via the next `/transactions/sync` |
| better-sqlite3 12 bundles SQLite 3.53.2 | `select sqlite_version()`, checked locally | `ALTER TABLE ... DROP COLUMN` (3.35+) is available |
| `Location` exposes `lat` / `lon`, not `latitude` / `longitude` | `plaid@45` `Location` | Field names in mapping code |

### Fields present in `/transactions/sync` and currently discarded

From `plaid@45` `Transaction`: `authorized_date`, `authorized_datetime`,
`datetime`, `original_description`, `iso_currency_code`,
`unofficial_currency_code`, `merchant_entity_id`,
`counterparties[]` (typed: `merchant` / `financial_institution` /
`payment_app` / `marketplace` / `payment_terminal` / `income_source`),
`payment_channel`, `transaction_code`, `location`, `payment_meta`, `website`,
`logo_url`, `check_number`, `account_owner`,
`personal_finance_category.confidence_level`,
`personal_finance_category_icon_url`.

## Scope

Four features, each independently shippable, in dependency order.

### Feature 1 — Transaction depth

**Problem.** `toTransactionRow` keeps eleven fields out of a much richer payload
the tool already pays for and receives.

**Why now, and no migration runner.** `src/core/db.ts` states its policy
explicitly:

> "There are no migrations: the tool has never shipped, so any mismatch means a
> database from a pre-release build, and the honest fix is to delete it and
> re-sync from Plaid rather than carry migration code forever."

That premise still holds — no production bank is linked and no access token
exists, so deleting the database costs nothing. Every schema change in this spec
therefore ships as a plain edit to `SCHEMA` plus a `SCHEMA_VERSION` bump, and
the developer deletes their sandbox database between builds. Building a
migration runner now would be exactly the speculative infrastructure the policy
refuses.

**The premise expires at the first production link**, not before. From that
moment the database holds access tokens, deleting it means re-linking every bank
and burning Item slots against the cap of 10, and additive migrations become
necessary. This is the real deadline on all four features: land the schema
changes first, link second.

Two supporting corrections, both in `applySchema`:

- The version-0 error claims *"No data is lost by deleting it — every row is
  re-downloadable from Plaid."* That is false the day a bank is linked, and it
  contradicts the README, which already says the enrollments are **not**
  re-downloadable. Fix the message.
- Record the expiry condition in the policy comment, so whoever reads it after
  the first link knows the reasoning no longer applies.

**Solution.** Store **every** field `/transactions/sync` returns. The data is
already fetched and already paid for; discarding it means a re-pull to recover
it, and the re-pull is only free while nothing is linked. Storage is not the
constraint — a null column costs about a byte in SQLite's record format, and
this is one person's ledger.

Schema v3 adds 33 columns to `transactions`:

| Group | Columns | Source |
|---|---|---|
| Timing | `authorized_date`, `authorized_datetime`, `datetime` | same names |
| Description | `original_description` | same name |
| Currency | `iso_currency_code`, `unofficial_currency_code` | stored separately, not coalesced |
| Category | `category_confidence`, `category_icon_url` | `personal_finance_category.confidence_level`, `personal_finance_category_icon_url` |
| Merchant | `merchant_entity_id`, `website`, `logo_url` | same names |
| Counterparty | `counterparty_type`, `counterparties_json` | `counterparties[0].type`, plus the whole array verbatim |
| Channel | `payment_channel`, `transaction_code` | same names |
| Instrument | `check_number`, `account_owner` | same names |
| Location (8) | `location_address`, `location_city`, `location_region`, `location_postal_code`, `location_country`, `location_lat`, `location_lon`, `location_store_number` | `location.*` |
| Payment meta (8) | `payment_meta_reference_number`, `payment_meta_ppd_id`, `payment_meta_payee`, `payment_meta_by_order_of`, `payment_meta_payer`, `payment_meta_payment_method`, `payment_meta_payment_processor`, `payment_meta_reason` | `payment_meta.*` |

Flat nested objects (`location`, `payment_meta`) are flattened to columns so they
are queryable. `counterparties` is an array of variable length carrying its own
nested `account_numbers` object, so it is stored as verbatim JSON with the
primary entry's `type` denormalised alongside for indexing.

Excluded, with reasons that are not "low value":

- `category`, `category_id`, `transaction_type` — **deprecated by Plaid.** A
  column for a field the vendor is removing is a column that becomes
  permanently null. `personal_finance_category` supersedes all three.
- `personal_finance_category.version` — describes the taxonomy revision, not
  the transaction.
- `merchant_category_code` — **not on `Transaction` in `plaid@45`.** Plaid's docs
  page lists it, but the SDK declares it only on `Credit1099`, an unrelated
  product. Caught by `tsc` during execution. If Plaid ever adds it to
  `Transaction`, it is one column away.

The existing `type` column holds `payment_channel` under a misleading name.
v3 drops it and declares `payment_channel` properly.

#### The real cost of storing everything, and how it is paid

Storage is free here. **Agent context is not.** A 43-column transaction row
serialised into an MCP tool result, times a hundred rows, is a large payload
that is mostly nulls — and it competes with the reasoning budget of the model
consuming it.

So the two boundaries diverge:

- **CLI `--json` emits every field.** It goes to a file, a pipe, or `jq`. Nothing
  is truncated and nothing is lost.
- **MCP `list_transactions` projects a lean subset by default**, with a
  `verbose: true` argument that returns the full row. The lean set is the fields
  an agent reasons with; the full set is there the moment it asks.

This keeps "store everything" true at the database — the layer where a mistake
is expensive and irreversible — without degrading the agent, which is the thing
the storage was for.

**Also in scope:** merchant grouping in `spendingSummary` keys on
`merchant_entity_id` (falling back to the name) while still *displaying* the
name, so "AMZN Mktp US*2K4" and "Amazon" stop splitting. `payment_channel`
becomes a `groupBy` option. Transaction search covers `original_description`.

### Feature 2 — Consent scope

**Problem.** Only `transactions` is consented at link time. Any future product
needs a browser round-trip per Item to obtain consent.

**Solution.** Request consent at link time for `liabilities`, `investments`,
`recurring_transactions`, and `transactions_refresh` via
`additional_consented_products`. Free until used. Add
`ledger auth consent [itemId]`, which runs update mode against an already-linked
Item to bring it up to the current consent set.

Record the consented list on the item row (schema v4, a plain `SCHEMA` edit —
see Feature 1) so features 3 and 4 can
give an actionable error instead of surfacing a raw Plaid rejection. Plaid's
`/item/get` remains authoritative; the local column is a record of what was
requested and accepted.

**Risk to resolve during implementation.** It is unverified whether Plaid accepts
`recurring_transactions` and `transactions_refresh` inside
`additional_consented_products` — some `Products` members are only valid in
certain request contexts. The plan includes a sandbox probe before the constant
is committed, and the constant must degrade to the accepted subset.

#### Probe result (sandbox, 2026-08-18)

```
accepted: liabilities, investments
rejected: recurring_transactions — /link/token/create: recurring_transactions is not a valid product for this field (INVALID_PRODUCT)
rejected: transactions_refresh — /link/token/create: transactions_refresh is not a valid product for this field (INVALID_PRODUCT)

Copy the accepted list into CONSENTED_PRODUCTS in src/core/plaid-client.ts.
```

This feature builds no liabilities or investments reader. It only preserves the
option cheaply.

### Feature 3 — Recurring transaction streams

**Problem.** Subscription, bill, and paycheck questions are unanswerable. They
cannot be reconstructed locally at comparable quality — Plaid's model is trained
cross-institution.

**Solution.** `/transactions/recurring/get` per Item into a `recurring_streams`
table (schema v5, a plain `SCHEMA` edit — see Feature 1), refreshed as a
whole-snapshot replace. Surface through `ledger recurring` and an MCP
`list_recurring` tool.

Per stream: `frequency` (WEEKLY / BIWEEKLY / SEMI_MONTHLY / MONTHLY / ANNUALLY /
UNKNOWN), `status` (MATURE / EARLY_DETECTION / TOMBSTONED / UNKNOWN),
`is_active`, `first_date`, `last_date`, `predicted_next_date`, `average_amount`,
`last_amount`, category, and the contributing transaction count.

`TOMBSTONED` is a free "this recurring charge stopped" signal. `EARLY_DETECTION`
is "this looks like a new subscription." Both are directly useful to an agent
and neither is derivable locally.

### Feature 4 — Forced institution refresh

**Problem.** `sync` returns whatever Plaid last ingested, with no indication of
how stale that is at the institution.

**Solution.** `/transactions/refresh` behind an explicit `ledger sync --force`
and a `force` argument on the MCP `sync` tool. Never the default — it is a
billed product on some plans, and the MCP tool description must say so.

## Non-goals

Webhooks (needs a public HTTPS endpoint; wrong shape for a local-first CLI),
Identity, Assets, Income, Signal, Transfer, Auth, Statements, and any
liabilities or investments *reader*. Stream editing (deprecated by Plaid).

## Global constraints

- Node >= 22, ESM, `pnpm` only. TypeScript strict; `pnpm typecheck` covers
  `src` and `tests`.
- Money is integer cents in SQLite; decimal dollars at every output boundary.
  Conversion happens only in `src/core/money.ts` (ingest) and
  `src/core/views.ts` (egress).
- Plaid's amount sign is preserved in storage: **positive means money left the
  account.** Aggregate outputs report positive magnitudes.
- Tests never reach the network. The Plaid SDK is injected through the
  `PlaidSdk` interface and stubbed.
- Reads never hit the Plaid API. Only `sync`, `auth`, `item remove`, and the new
  `auth consent` and `recurring refresh` paths make network calls.
- Every CLI command supports `--json` except `init`.
- CLI and MCP must share the same view functions so their numbers cannot drift.
- Exit codes: `0` ok, `1` general, `2` config, `3` needs re-authentication.
- **No migration code.** Schema changes are plain edits to `SCHEMA` plus a
  `SCHEMA_VERSION` bump; a stale sandbox database is rejected loudly and the
  developer deletes it. This is only legitimate until the first production
  Item exists — see Feature 1.
- **Land every schema change before linking a production bank.** After that,
  deleting the database costs Item slots and this constraint inverts.

## Feature dependency order

```
1 (migrations + depth)  →  2 (consent)  →  3 (recurring)
                                        →  4 (refresh)
```

3 and 4 are independent of each other. 4 improves 3's freshness, so shipping 4
before 3 is also valid.

## Success criteria

1. A stale sandbox database is rejected with a message that names the real cost
   of deleting it — re-linking every bank — rather than claiming no data is lost.
2. A freshly created database carries every column and index the row types
   declare, verified by round-tripping a fully populated row.
3. `spending --by merchant` groups Amazon name variants into one row.
4. `ledger auth consent <item>` completes against an existing Item without
   creating a second Item.
5. `ledger recurring` lists streams with predicted next dates after a sandbox
   sync.
6. `ledger sync --force` issues `/transactions/refresh` before syncing; plain
   `ledger sync` never does.
7. `pnpm test` and `pnpm typecheck` pass at every task boundary.
