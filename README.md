# ledger-local

Local-first personal finance data. Syncs accounts and transactions from
[Plaid](https://plaid.com/docs) into a local SQLite database. Query it from a CLI
or let an agent query it through MCP — reads never hit the Plaid API.

## Setup

1. Create a Plaid account at https://dashboard.plaid.com/signup. US/CA signups
   get a **Trial plan**: real production data, auto-approved, up to **10 Items**
   (an Item is one bank connection and can hold many accounts).
2. Copy your `client_id` and secret from **Dashboard → Developers → Keys**.
   Start with the Sandbox secret; switch to Production when you want real banks.
3. Create `~/.config/ledger/config.json`:
   ```json
   { "clientId": "...", "secret": "...", "environment": "sandbox" }
   ```
4. `chmod 600 ~/.config/ledger/config.json` — it holds a live API secret.
   The CLI warns on every run if the file is group- or world-readable.
5. `pnpm install && pnpm build`
6. Link a bank: `node dist/cli/index.js auth`

`auth` uses Plaid **Hosted Link**: it opens a Plaid-hosted page in your browser
and polls `/link/token/get` until the session finishes. There is no local web
server and no redirect URI to configure.

> If OAuth banks (Chase, Capital One) do not appear in the institution list, add
> a redirect URI under **Dashboard → Developers → API → Allowed redirect URIs**
> and see `createLinkToken`'s `redirectUri` option. Plaid allows
> `http://localhost` only in Sandbox; Production requires HTTPS.

## CLI

```
ledger auth                       link a bank (browser)
ledger auth status                linked institutions, item ids, sync state
ledger auth repair <item_id>      re-authenticate an existing bank
ledger sync [--account|--item id] refresh from Plaid
ledger accounts                   balances (local)
ledger transactions [filters]     query (local)
ledger spending --from --to       rollups (local)
```

Every command takes `--json`. Reads report staleness (>24h since sync).

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

## MCP

Register `dist/mcp/index.js` as a stdio MCP server. Tools: `list_accounts`,
`list_transactions`, `spending_summary`, `sync`, `auth_status`. Linking and
repairing a bank are CLI-only — both need a human at a browser.

## State

- Config: `~/.config/ledger/config.json` (chmod 600; contains your Plaid secret)
- Database: `~/.local/share/ledger/ledger.db` (chmod 600; contains access tokens)
- Override with `LEDGER_CONFIG_DIR` / `LEDGER_DATA_DIR`.

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
