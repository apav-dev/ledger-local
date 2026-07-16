# teller-local

Local-first personal finance data. Syncs accounts and transactions from the
[Teller API](https://teller.io/docs) (development environment: real banks, free,
100-enrollment cap) into a local SQLite database. Query it from a CLI or let an
agent query it through MCP — reads never hit the Teller API.

## Setup

1. Create a Teller application at https://teller.io and download the client
   certificate pair.
2. Create `~/.config/teller/config.json`:
   `{ "applicationId": "app_...", "environment": "development" }`
3. Save `certificate.pem` and `private_key.pem` next to it (`chmod 600`).
4. `pnpm install && pnpm build`
5. Link a bank: `node dist/cli/index.js auth` (opens Teller Connect in your
   browser; initial sync pulls all available history).

## CLI

    teller auth                      link a bank (browser)
    teller auth status               enrollments + cert status
    teller sync [--account id]      refresh from Teller
    teller accounts                  balances (local)
    teller transactions [filters]    query (local)
    teller spending --from --to      rollups (local)

Every command takes `--json`. Reads report staleness (>24h since sync).

## MCP

Register `dist/mcp/index.js` as a stdio MCP server. Tools: `list_accounts`,
`list_transactions`, `spending_summary`, `sync`, `auth_status`. Enrollment is
CLI-only (needs a human at a browser).

## State

- Config + certs: `~/.config/teller/`
- Database: `~/.local/share/teller/teller.db` (chmod 600; contains access tokens)
- Override with `TELLER_CONFIG_DIR` / `TELLER_DATA_DIR`.

## Development

    pnpm test        # vitest
    pnpm typecheck
    pnpm cli -- accounts   # run CLI from source via tsx
