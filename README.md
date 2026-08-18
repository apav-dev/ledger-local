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
ledger sync [--account|--item id] refresh from Plaid
ledger accounts                   balances (local)
ledger transactions [filters]     query (local)
ledger spending --from --to       rollups (local)
```

Every command takes `--json` except `init`, which is a conversation rather than a
query. Reads report staleness (>24h since sync).

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
`list_transactions`, `spending_summary`, `sync`, `auth_status`. Setup, linking,
and repairing a bank are CLI-only — all three need a human at a terminal or a
browser.

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
