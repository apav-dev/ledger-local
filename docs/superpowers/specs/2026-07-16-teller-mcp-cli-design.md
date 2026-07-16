# Teller CLI + MCP — Design

**Date:** 2026-07-16
**Status:** Approved

## Purpose

Replace the my-money web/mobile/Convex stack with a local-first financial data tool for a single user. An agent (Hermes, running on a spare machine) queries transactions and spending habits through an MCP server or CLI. Data syncs from the Teller API (development environment: real banks, free, 100-enrollment cap) into a local SQLite database so reads never hit the rate-limited API.

## Decisions

| Decision | Choice |
| --- | --- |
| Repo strategy | Raze in place: `git init` fresh in this directory, delete everything not ported, build at root. GitHub copy of old code remains as archive. |
| Language/runtime | TypeScript on Node (ports existing `tellerClient`). |
| Database | SQLite via `better-sqlite3`, hand-written SQL. No ORM. |
| Interfaces | Both CLI and MCP stdio server in v1, thin wrappers over one shared core. |
| Sync policy | Explicit only. Every query result carries staleness metadata; the agent decides when to call `sync`. |
| Tool surface | Raw data + basic rollups (spending summary). No trend/budget analytics in v1. |
| Teller environment | `development` (real banks). `sandbox` selectable via config/env for smoke tests. |

## Architecture

Single package, flat `src/`. Internal boundary rule: `core/` never imports from `cli/`, `mcp/`, or `auth/`.

```
src/
├── core/
│   ├── teller-client.ts   # ported from apps/web/src/lib/tellerClient.ts; cleaned, typed
│   ├── db.ts              # schema DDL, migrations, upserts, connection
│   ├── sync.ts            # orchestration: balances + paginated transaction sync
│   ├── queries.ts         # listAccounts, listTransactions, spendingSummary, authStatus
│   └── config.ts          # config file + cert loading, env overrides
├── cli/                   # commander program: auth, sync, accounts, transactions, spending
├── mcp/                   # @modelcontextprotocol/sdk stdio server, 5 tools
└── auth/                  # ephemeral localhost enrollment server + Teller Connect page
```

Ported from old repo before teardown:

- `apps/web/src/lib/tellerClient.ts` — mTLS client (strip debug logging, add types, keep `count`/`from_id` support)
- `apps/web/src/server/teller.sync.ts` + `teller.refresh.ts` — sync orchestration shape
- `apps/expo/types/teller.ts`, `TellerTypes.ts`, `TransactionCategories.ts` — API types + category mapping
- `convex/schema.ts` — reference for SQL schema

Everything else (apps/web, apps/expo, convex/, root app/, components/, utils/, types/, docs cruft, convex.log) is deleted.

## Data model

```sql
enrollments (
  id            TEXT PRIMARY KEY,   -- Teller enrollment id
  access_token  TEXT NOT NULL,
  institution   TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

accounts (
  id                 TEXT PRIMARY KEY,  -- Teller account id
  enrollment_id      TEXT NOT NULL REFERENCES enrollments(id),
  name               TEXT NOT NULL,
  institution        TEXT NOT NULL,
  type               TEXT NOT NULL,     -- depository | credit
  subtype            TEXT,              -- checking, savings, credit_card, ...
  last_four          TEXT NOT NULL,
  currency           TEXT NOT NULL,
  status             TEXT NOT NULL,
  available_balance  REAL,
  ledger_balance     REAL,
  last_synced_at     INTEGER
);

transactions (
  id              TEXT PRIMARY KEY,     -- Teller transaction id
  account_id      TEXT NOT NULL REFERENCES accounts(id),
  date            TEXT NOT NULL,        -- ISO yyyy-mm-dd
  description     TEXT NOT NULL,
  amount          REAL NOT NULL,        -- Teller sign convention preserved
  category        TEXT,
  counterparty    TEXT,
  status          TEXT NOT NULL,        -- posted | pending
  type            TEXT NOT NULL,
  running_balance REAL
);

CREATE INDEX idx_txn_account_date ON transactions(account_id, date);
CREATE INDEX idx_txn_date ON transactions(date);
CREATE INDEX idx_txn_category ON transactions(category);
```

Changes vs the old Convex schema: no `userId` (single user); `enrollments` table replaces the single-token design so multiple banks work; Teller ids are natural primary keys (removes the old id-mapping layer); `subtype` replaces name-substring account grouping.

## Config and file locations

```
~/.config/teller/
  config.json        # { applicationId, environment }
  certificate.pem    # mTLS client cert   (chmod 600)
  private_key.pem    # mTLS private key   (chmod 600)
~/.local/share/teller/
  teller.db          # SQLite; contains access tokens (chmod 600)
```

- All state lives outside the repo; the repo is stateless and safe to publish.
- `TELLER_CONFIG_DIR` / `TELLER_DATA_DIR` env overrides for testing.
- Access tokens stored in SQLite with owner-only file permissions. No keychain integration in v1.

## Core query surface

| Function | Params | Returns |
| --- | --- | --- |
| `listAccounts()` | — | accounts with balances and per-account `last_synced_at` |
| `listTransactions(f)` | `accountId?, from?, to?, category?, search?, status?, limit? (default 100), offset?` | rows + total count |
| `spendingSummary(f)` | `from, to, groupBy: category\|merchant\|month\|account, accountId?` | groups with total, count, share % |
| `syncAll()` / `syncAccount(id)` | — | per-account inserted/updated counts and errors |
| `authStatus()` | — | enrollments, account counts, cert presence/validity |

- `search` is SQL `LIKE` over description + counterparty.
- `spendingSummary` defaults: excludes pending transactions; counts only spend, defined as `amount < 0` (Teller's sign convention, preserved in storage: outflows negative). Flags to include pending and/or inflows. If real-account data shows a different sign convention per account type, the spend filter is corrected in one place (`queries.ts`) during implementation.
- Every query result includes `meta: { last_synced_at, stale }` where `stale = last_synced_at > 24h ago`.

## CLI

```
teller auth                # enrollment flow (below)
teller auth status
teller sync [--account <id>]
teller accounts
teller transactions [--account] [--from] [--to] [--category] [--search] [--limit]
teller spending --from <date> --to <date> [--by category|merchant|month|account]
```

Human-readable tables by default; `--json` on every command for agent/script use. Errors to stderr with distinct exit codes.

## MCP server

`teller-mcp`, stdio transport, five tools mapping 1:1 to core: `list_accounts`, `list_transactions`, `spending_summary`, `sync`, `auth_status`. Inputs validated with zod schemas. Tool descriptions written for agent decision-making (e.g. `sync`: "Refreshes the local cache from the bank via the Teller API. Call when results show `stale: true` and current data matters. Takes ~5–30s.").

Enrollment is deliberately not an MCP tool — it requires a human at a browser. `auth_status` output tells the agent to ask the user to run `teller auth`.

## Auth flow (`teller auth`)

1. Preflight: config and certs present? If not, print setup instructions (Teller dashboard URL, expected file paths) and exit.
2. Start ephemeral HTTP server on `localhost:8021`. `GET /` serves an inline HTML page loading `https://cdn.teller.io/connect/connect.js` configured with `{ applicationId, environment: 'development', selectAccount: 'multiple' }`. `POST /callback` receives `{ accessToken, enrollment }`.
3. Open the user's browser; user completes real bank login in the Teller Connect widget.
4. On callback: upsert enrollment row, run initial (exhaustive) sync for its accounts, print summary, shut down the server.
5. No callback within 5 minutes: clean exit with a message. Re-running for an existing institution upserts the enrollment — idempotent.

## Sync semantics

Per account, wrapped in one SQLite transaction:

1. Fetch balances; upsert account row.
2. Paginate transactions with `count=1000` + `from_id` (Teller pages backward — `from_id` returns transactions older than the given id):
   - **Initial sync** (no transactions stored for the account): drain until an empty page. This pulls the institution's full available history — depth is institution-determined (commonly ~90 days, sometimes more) and cannot be extended by the client.
   - **Incremental sync**: fetch newest page; stop as soon as a page contains only already-known transaction ids, otherwise keep paging.
3. Upsert transactions by Teller id — pending→posted transitions update status/amount in place.
4. Set `last_synced_at` only on success.

Accounts sync independently; one institution failing does not block others. Results report per-account success/failure. Because the local DB never deletes, history accumulates beyond the bank's sliding window over time.

**Implementation deviation (approved):** per-account work is NOT wrapped in one SQLite transaction as originally written above — `better-sqlite3` transactions are synchronous-only, and they cannot wrap the async pagination loop (each page requires an `await` on the Teller API). Instead, each page's `upsertTransactions` call commits independently as pagination proceeds. The DB remains consistent because upserts are idempotent (keyed by Teller transaction id), and `last_synced_at` is still only set after the full account sync succeeds — a failure partway through a multi-page sync leaves already-committed pages in place and simply retries them (as already-known ids) on the next run, rather than rolling back.

## Error handling

Small typed error set mapped at both wrappers:

| Condition | CLI | MCP |
| --- | --- | --- |
| Missing certs/config | exit 2 + setup instructions | tool error: "run `teller auth` setup" |
| 401 / enrollment disconnected | exit 3 + "re-run `teller auth` for <institution>" | tool error, same message, `needs_reauth: true` |
| 429 rate limit | one retry with backoff, then fail with wait hint | same |
| Network / 5xx during sync | fail that account, continue others | partial result + errors array |

No retry queues or circuit breakers — single-user tool; the agent retries.

## Testing

- **Core queries + rollups** (primary coverage): vitest against in-memory SQLite with seeded fixtures.
- **Sync pagination**: `TellerClient` behind an interface; fake client returns scripted pages to verify drain, overlap-stop, and per-account error isolation.
- **Live client**: one manual smoke test against the sandbox environment; not in CI.
- **MCP**: tool schema validation tests; manual end-to-end from an MCP-capable harness.

## Out of scope (v1)

- Trend analysis, recurring-charge detection, budgets
- Webhooks, cron/scheduled sync
- Multi-user anything, keychain storage
- Custom category overrides (Teller's categories used as-is; an override table can be added later without schema breakage)
