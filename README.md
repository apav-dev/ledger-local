# ledger-local

Local-first personal finance data. Syncs accounts and transactions from
[Plaid](https://plaid.com/docs) into a local SQLite database. Query it from a CLI
or let an agent query it through MCP — reads never hit the Plaid API.

## Setup

1. Create a Plaid account at https://dashboard.plaid.com/signup. US/CA signups
   get a **Trial plan**: real production data, auto-approved, up to **10 Items**
   (an Item is one bank connection and can hold many accounts).
2. `pnpm install && pnpm build`
3. `node dist/cli/index.js init`

`init` asks which environment you want, opens **Dashboard → Developers → Keys**
in your browser, takes your `client_id` and secret (the secret is not echoed),
and verifies them against Plaid before writing anything. It then writes
`~/.config/ledger/config.json` at mode 600 and offers to link your first bank.

Plaid has no API for fetching developer credentials — they exist only in the
dashboard — so the paste step cannot be automated.

The verification call is `/link/token/create`, which is the cheapest way to
prove all three things setup can get wrong at once: the keys are valid, they
belong to the environment you picked, and Hosted Link is enabled for your
`client_id`. Nothing is written to disk until it succeeds.

### Writing the config by hand

`init` needs an interactive terminal. Without one, create
`~/.config/ledger/config.json` yourself:

```json
{ "clientId": "...", "secret": "...", "environment": "sandbox" }
```

Then `chmod 600` it — the file holds a live API secret, and the CLI warns on
every run if it is group- or world-readable.

### Sandbox first

Start with the Sandbox secret. Sandbox is free and unlimited, uses fake banks
(`user_good` / `pass_good`, MFA `1234`), and exercises the entire path — Hosted
Link, token exchange, `/transactions/sync`, SQLite. Every Item you link in
Production permanently consumes one of your 10 Trial slots.

### Sandbox and Production do not mix

Access tokens are environment-scoped: a Sandbox token is meaningless to the
Production host, and nothing in the token's text says which it is. The database
records the environment that created it and refuses to open under the other one,
so flipping `environment` in an existing config fails immediately instead of
producing an authentication error on every bank.

Keep them in separate directories:

```bash
export LEDGER_CONFIG_DIR=~/.config/ledger-prod
export LEDGER_DATA_DIR=~/.local/share/ledger-prod
node dist/cli/index.js init
```

`auth` uses Plaid **Hosted Link**: it opens a Plaid-hosted page in your browser
and polls `/link/token/get` until the session finishes. There is no local web
server and no redirect URI to configure.

> If OAuth banks (Chase, Capital One) do not appear in the institution list, add
> a redirect URI under **Dashboard → Developers → API → Allowed redirect URIs**
> and see `createLinkToken`'s `redirectUri` option. Plaid allows
> `http://localhost` only in Sandbox; Production requires HTTPS.

## CLI

```
ledger init [--force]             first-run setup (interactive)
ledger auth                       link a bank (browser)
ledger auth status                linked institutions, item ids, sync state
ledger auth repair <item_id>      re-authenticate an existing bank
ledger item remove <item_id>      permanently delete a bank connection
ledger sync [--account|--item id] refresh from Plaid
ledger accounts                   balances (local)
ledger transactions [filters]     query (local)
ledger spending --from --to       rollups (local)
ledger categories                 known categories with counts (local)
```

Every command takes `--json` except `init`, which is a conversation rather than a
query. Reads report staleness (>24h since sync).

### Dates and categories

`--from`/`--to` (on `transactions` and `spending`) accept an absolute `yyyy-mm-dd`
or a relative keyword: `today`, `yesterday`, `this-month`, `last-month`,
`end-of-last-month`, `this-year`, or `<N>-days-ago` (e.g. `30-days-ago`). An
invalid date, or `--from` after `--to`, is rejected with an error — it never
silently produces an empty result.

`--category` matches Plaid's primary personal-finance category
case-insensitively (`food_and_drink` matches `FOOD_AND_DRINK`); use
`UNCATEGORIZED` for transactions with no category. Plaid ships no fixed list of
valid categories, so `ledger categories` is the source of truth for what
actually exists in your data — an unknown value is rejected with the real list
rather than silently returning nothing.

`init --force` replaces an existing config and asks for confirmation first.
Changing credentials invalidates the access tokens your linked banks were
created under, so this is not a routine operation.

Exit codes: `0` ok, `1` general failure, `2` config problem, `3` a bank needs
re-authentication.

### Use `auth repair`, not `auth`, to fix a broken connection

When Plaid returns `ITEM_LOGIN_REQUIRED`, the connection needs re-authentication.
`ledger auth repair <item_id>` uses Link update mode, which reuses the existing
Item and preserves its sync cursor. Running plain `ledger auth` instead would
create a **second** Item for the same bank and consume another of your 10 slots.

## Transaction history depth

`ledger auth` requests **730 days** — Plaid's maximum. This is set once, when the
Item is created, and Plaid does not allow raising it afterwards:

> The maximum amount of transaction history to request on an Item cannot be
> updated if Transactions has already been added to the Item.

So the depth is a permanent property of each connection. Anything older than two
years is not available through Plaid at any setting; it stays with your bank.

Fetching older history later with `/transactions/get` does **not** work around
this. `days_requested` controls what Plaid pulls from the institution and stores,
not what it returns to you — a wider date range just reads the same 90 or 730 day
window Plaid actually ingested.

If a connection does end up with too little history, the only fix is
`ledger item remove <item_id>` followed by a fresh `ledger auth`. That creates a
new Item with a new id and re-pulls from scratch.

### The first sync after linking may not finish immediately

Plaid assembles the historical pull in the background, and two years on an active
account takes minutes. `ledger auth` polls for up to 5 minutes; past that it
reports a sync failure even though the bank is linked correctly.

**Run `ledger sync` a few minutes later — not `ledger auth`.** Re-running `auth`
creates a second Item for the same bank and consumes another of your 10 slots.
The cursor is incremental, so a later `sync` picks up everything.

## Removing a connection

```
ledger item remove <item_id> [--yes]
```

Removes the Item at Plaid, then deletes its accounts and transactions locally.
Irreversible on both sides: the access token stops working immediately, and
reconnecting produces a new Item with a new id.

The order matters. The access token is the only way to remove an Item and it
lives in the row being deleted, so removal happens at Plaid first. If Plaid
refuses, local data is left untouched and the command can be retried — otherwise
the Item would be stranded upstream, still occupying a slot with no way to reach
it.

Requires a confirmation prompt unless `--yes` is passed.

## Amount sign convention

**Amounts are stored exactly as Plaid sends them, which is the inverse of a bank
statement:**

| Amount | Meaning |
|---|---|
| positive | money **left** the account — a purchase, payment, or fee |
| negative | money **entered** the account — a paycheck, refund, or deposit |

`spending` and the `spending_summary` MCP tool always report **positive dollar
totals**, so you never need to reason about the sign when looking at rollups.
Only raw transaction rows expose the convention.

### Amounts are stored as integer cents

The database stores money as `INTEGER` cents (`amount_cents`,
`current_balance_cents`), never as floating-point dollars, so sums are exact and
equality comparisons are safe. Everything that leaves the process — `--json`,
every MCP tool result — is converted back to decimal dollars under the ordinary
field names (`amount`, `current_balance`, `total`). Nothing outside the process
sees cents, so there is no scale to keep track of.

The conversion happens in one place each way: `src/core/money.ts` at ingest,
`src/core/views.ts` on output. Both frontends share the same views, so the CLI
and MCP cannot report different numbers.

## MCP

Register `dist/mcp/index.js` as a stdio MCP server. Tools: `list_accounts`,
`list_transactions`, `list_categories`, `spending_summary`, `sync`,
`auth_status`. Setup, linking, and repairing a bank are CLI-only — all three
need a human at a terminal or a browser.

## State

- Config: `~/.config/ledger/config.json` (chmod 600; contains your Plaid secret)
- Database: `~/.local/share/ledger/ledger.db` (chmod 600; contains access tokens)
- Override with `LEDGER_CONFIG_DIR` / `LEDGER_DATA_DIR`.

**Neither lives in this repo.** Cloning it on another machine gets you the code
and nothing else — no credentials, no linked banks. Running `ledger init` and
`ledger auth` there creates a *second* Item for the same bank and consumes
another of your 10 slots. To move an existing setup, copy both files (and the
database's `-wal` / `-shm` siblings) and re-apply `chmod 600`. Access tokens are
bound to your `client_id` and environment, not to a machine, so they keep
working. Two copies syncing independently will diverge — each carries its own
cursor and there is no merge.

The database records its schema version in `PRAGMA user_version` and the Plaid
environment that created it. There are no migrations: a database written by an
incompatible build, or opened under the wrong environment, is rejected with an
explanation rather than silently misbehaving.

Deleting the database loses your access tokens, which means re-linking every
bank and spending Item slots again. Transactions are all re-downloadable; the
enrollments are not.

## How sync works

Plaid's `/transactions/sync` is cursor-based. Each Item stores its own cursor; a
`NULL` cursor means the next sync is a full backfill (Plaid provides up to ~24
months, institution depending). Every page's rows and its new cursor commit in a
single SQLite transaction — a cursor saved without its rows would lose those
transactions permanently, because Plaid never resends them.

Sync also applies Plaid's `removed` list. This matters: when a pending
transaction posts, Plaid assigns the posted row a **new** `transaction_id` and
returns the old pending id under `removed`. Skipping the delete would
double-count that spend forever.

## Development

```
pnpm test        # vitest
pnpm typecheck   # src and tests
pnpm cli -- accounts   # run CLI from source via tsx
```

Tests never reach the network — the Plaid SDK is injected through the `PlaidSdk`
interface and stubbed.
