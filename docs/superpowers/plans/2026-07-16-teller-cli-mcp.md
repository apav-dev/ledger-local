# Teller CLI + MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the my-money web/Convex stack with a local-first TypeScript tool — a `teller` CLI and a `teller-mcp` stdio MCP server sharing one core — that syncs bank data from the Teller API into SQLite for agent querying.

**Architecture:** Single package, flat `src/`. `core/` (config, db, teller-client, sync, queries) has no knowledge of `cli/`, `mcp/`, or `auth/`. CLI and MCP are thin wrappers over the same core functions. All state (config, mTLS certs, SQLite db) lives outside the repo under `~/.config/teller` and `~/.local/share/teller`.

**Tech Stack:** Node ≥22, TypeScript (strict, NodeNext ESM), better-sqlite3 (raw SQL), undici (mTLS HTTP), commander (CLI), @modelcontextprotocol/sdk + zod (MCP), vitest (tests), pnpm.

**Spec:** `docs/superpowers/specs/2026-07-16-teller-mcp-cli-design.md` — read it before starting any task.

## Global Constraints

- Package manager: **pnpm only**. Never npm or yarn.
- ESM everywhere: `"type": "module"`, Node built-ins imported via `node:` prefix, relative imports use `.js` extensions.
- TypeScript strict; no `any` (use `unknown` + narrowing); no `enum` (use `as const` / literal unions); named exports only.
- Teller sign convention preserved: amounts stored as-is (outflows negative). Spend filter is `amount < 0`, defined only in `src/core/queries.ts`.
- Teller API environment comes from config; `development` is the default. Client mTLS certs required for `development`/`production`, not for `sandbox`.
- Staleness: a result is `stale` when the relevant `last_synced_at` is null or older than 24 hours.
- All secrets (certs, tokens, db) live outside the repo. Nothing under the repo root may contain credentials.
- Commit after every task (conventional commits). Work on branch `feat/teller-cli-mcp`.

---

## File Structure (final state)

```
my-money/
├── package.json                 # bins: teller → dist/cli/index.js, teller-mcp → dist/mcp/index.js
├── tsconfig.json
├── vitest.config.ts
├── .gitignore
├── README.md
├── docs/superpowers/...         # spec + this plan
├── src/
│   ├── core/
│   │   ├── types.ts             # Teller API wire types
│   │   ├── config.ts            # config/cert/db path resolution, ConfigError
│   │   ├── db.ts                # schema, openDb, upserts, row types
│   │   ├── teller-client.ts     # TellerApi interface + undici mTLS implementation
│   │   ├── sync.ts              # syncAll/syncEnrollment, pagination, mapping
│   │   └── queries.ts           # listAccounts/listTransactions/spendingSummary/authStatus
│   ├── auth/
│   │   └── server.ts            # ephemeral enrollment server + Connect page HTML
│   ├── cli/
│   │   ├── index.ts             # commander program (entry, shebang)
│   │   └── format.ts            # table/money formatting
│   └── mcp/
│       ├── server.ts            # buildMcpServer(deps) — 5 tools
│       └── index.ts             # stdio entry (shebang)
└── tests/
    ├── config.test.ts
    ├── db.test.ts
    ├── teller-client.test.ts
    ├── sync.test.ts
    ├── queries.test.ts
    ├── auth-server.test.ts
    ├── format.test.ts
    ├── mcp.test.ts
    └── helpers.ts               # seeded in-memory db fixtures
```

---

### Task 1: Teardown and scaffold

**Files:**
- Delete: all legacy app code (exact list below)
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `docs/legacy-reference/` (gitignored working copies)

**Interfaces:**
- Consumes: nothing
- Produces: installable, type-checkable empty project skeleton on branch `feat/teller-cli-mcp`

- [ ] **Step 1: Create branch**

```bash
cd /Users/aaron/Dev/my-money
git checkout -b feat/teller-cli-mcp
```

- [ ] **Step 2: Preserve legacy reference copies (gitignored — for reading during later tasks, deleted in Task 10)**

```bash
mkdir -p docs/legacy-reference
cp apps/web/src/lib/tellerClient.ts docs/legacy-reference/
cp apps/web/src/server/teller.sync.ts docs/legacy-reference/
cp apps/web/src/server/teller.refresh.ts docs/legacy-reference/
cp apps/expo/types/teller.ts docs/legacy-reference/teller-types.ts
cp apps/expo/types/TellerTypes.ts docs/legacy-reference/
cp apps/expo/types/TransactionCategories.ts docs/legacy-reference/
cp convex/schema.ts docs/legacy-reference/convex-schema.ts
```

- [ ] **Step 3: Delete legacy code**

```bash
rm -rf app apps components convex tools types utils
rm -f convex.log IMPLEMENTATION_SUMMARY.md package-lock.json package.json \
      pnpm-lock.yaml pnpm-workspace.yaml prettier.config.mjs README.md \
      TELLER_CONNECT.md tsconfig.json utils.ts
ls   # expect only: docs
```

- [ ] **Step 4: Write `.gitignore`**

```gitignore
node_modules/
dist/
*.pem
.env
docs/legacy-reference/
*.db
```

- [ ] **Step 5: Write `package.json`**

```json
{
  "name": "teller-local",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "packageManager": "pnpm@10.12.1",
  "bin": {
    "teller": "dist/cli/index.js",
    "teller-mcp": "dist/mcp/index.js"
  },
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "cli": "tsx src/cli/index.ts",
    "mcp": "tsx src/mcp/index.ts"
  }
}
```

(If installed pnpm version differs, set `packageManager` to `pnpm --version` output.)

- [ ] **Step 6: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "sourceMap": true,
    "types": ["node"]
  },
  "include": ["src"]
}
```

- [ ] **Step 7: Write `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
```

- [ ] **Step 8: Install dependencies**

```bash
pnpm add better-sqlite3 commander zod undici @modelcontextprotocol/sdk
pnpm add -D typescript vitest tsx @types/node @types/better-sqlite3
```

Expected: lockfile created, no errors. Verify native module loads:

```bash
node -e "import('better-sqlite3').then(() => console.log('sqlite ok'))"
```

Expected: `sqlite ok`

- [ ] **Step 9: Commit (two commits: teardown, then scaffold)**

```bash
git add -A
git commit -m "chore: tear down legacy web/expo/convex stack"
```

(The teardown files were never tracked in this fresh repo, so this commit contains the new scaffold files; the deletion itself leaves no history — GitHub archive holds the old code. One commit is fine:)

```bash
git commit -am "chore: scaffold teller-local package" --allow-empty
```

If the first commit already captured everything, skip the second.

---

### Task 2: Core types and config

**Files:**
- Create: `src/core/types.ts`, `src/core/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `types.ts`: `TellerEnvironment`, `TellerAccount`, `TellerBalance`, `TellerTransaction`, `TellerApi`
  - `config.ts`: `interface TellerConfig { applicationId: string; environment: TellerEnvironment; configDir: string; certPath: string; keyPath: string; dbPath: string }`, `class ConfigError extends Error`, `loadConfig(env?: NodeJS.ProcessEnv): TellerConfig`, `certsPresent(cfg: TellerConfig): boolean`, `setupInstructions(configDir: string): string`

- [ ] **Step 1: Write `src/core/types.ts`** (wire types match Teller API JSON — see `docs/legacy-reference/TellerTypes.ts` for shape reference; amounts arrive as strings)

```ts
export type TellerEnvironment = 'sandbox' | 'development' | 'production';

export interface TellerInstitution {
  id: string;
  name: string;
}

export interface TellerAccount {
  id: string;
  enrollment_id: string;
  name: string;
  type: 'depository' | 'credit';
  subtype?: string;
  last_four: string;
  currency: string;
  status: string;
  institution: TellerInstitution;
}

export interface TellerBalance {
  account_id: string;
  available: string | null;
  ledger: string | null;
}

export interface TellerCounterparty {
  name?: string | null;
  type?: string | null;
}

export interface TellerTransactionDetails {
  processing_status: string;
  category?: string | null;
  counterparty?: TellerCounterparty | null;
}

export interface TellerTransaction {
  id: string;
  account_id: string;
  date: string; // yyyy-mm-dd
  description: string;
  amount: string; // signed decimal string, outflows negative
  status: 'posted' | 'pending';
  type: string;
  running_balance: string | null;
  details: TellerTransactionDetails;
}

export interface TellerApi {
  listAccounts(accessToken: string): Promise<TellerAccount[]>;
  getBalance(accessToken: string, accountId: string): Promise<TellerBalance>;
  listTransactions(
    accessToken: string,
    accountId: string,
    opts?: { count?: number; fromId?: string },
  ): Promise<TellerTransaction[]>;
}
```

- [ ] **Step 2: Write the failing tests — `tests/config.test.ts`**

```ts
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, certsPresent, loadConfig } from '../src/core/config.js';

let dir: string;

function makeConfigDir(contents?: string): NodeJS.ProcessEnv {
  dir = mkdtempSync(path.join(tmpdir(), 'teller-test-'));
  const configDir = path.join(dir, 'config');
  const dataDir = path.join(dir, 'data');
  mkdirSync(configDir, { recursive: true });
  if (contents !== undefined) {
    writeFileSync(path.join(configDir, 'config.json'), contents);
  }
  return { TELLER_CONFIG_DIR: configDir, TELLER_DATA_DIR: dataDir };
}

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('loadConfig', () => {
  it('throws ConfigError with setup instructions when config.json missing', () => {
    const env = makeConfigDir(undefined);
    expect(() => loadConfig(env)).toThrow(ConfigError);
    expect(() => loadConfig(env)).toThrow(/config\.json/);
  });

  it('loads applicationId and defaults environment to development', () => {
    const env = makeConfigDir(JSON.stringify({ applicationId: 'app_123' }));
    const cfg = loadConfig(env);
    expect(cfg.applicationId).toBe('app_123');
    expect(cfg.environment).toBe('development');
    expect(cfg.dbPath.endsWith('teller.db')).toBe(true);
    expect(cfg.certPath.endsWith('certificate.pem')).toBe(true);
  });

  it('rejects invalid environment values', () => {
    const env = makeConfigDir(
      JSON.stringify({ applicationId: 'app_123', environment: 'prod' }),
    );
    expect(() => loadConfig(env)).toThrow(ConfigError);
  });

  it('certsPresent is false until both pem files exist', () => {
    const env = makeConfigDir(JSON.stringify({ applicationId: 'app_123' }));
    const cfg = loadConfig(env);
    expect(certsPresent(cfg)).toBe(false);
    writeFileSync(cfg.certPath, 'CERT');
    writeFileSync(cfg.keyPath, 'KEY');
    expect(certsPresent(cfg)).toBe(true);
  });
});
```

- [ ] **Step 3: Run tests, verify failure**

```bash
pnpm vitest run tests/config.test.ts
```

Expected: FAIL — cannot resolve `../src/core/config.js`.

- [ ] **Step 4: Write `src/core/config.ts`**

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { TellerEnvironment } from './types.js';

const ConfigFileSchema = z.object({
  applicationId: z.string().min(1),
  environment: z.enum(['sandbox', 'development', 'production']).default('development'),
});

export interface TellerConfig {
  applicationId: string;
  environment: TellerEnvironment;
  configDir: string;
  certPath: string;
  keyPath: string;
  dbPath: string;
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

export function setupInstructions(configDir: string): string {
  return [
    `Teller is not configured. To set up:`,
    `  1. Create a Teller application at https://teller.io (dashboard).`,
    `  2. Download your client certificate pair from the dashboard.`,
    `  3. Create ${path.join(configDir, 'config.json')} containing:`,
    `       { "applicationId": "app_...", "environment": "development" }`,
    `  4. Save the certificate as ${path.join(configDir, 'certificate.pem')}`,
    `     and the key as ${path.join(configDir, 'private_key.pem')} (chmod 600 both).`,
    `  5. Run: teller auth`,
  ].join('\n');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): TellerConfig {
  const configDir = env['TELLER_CONFIG_DIR'] ?? path.join(os.homedir(), '.config', 'teller');
  const dataDir = env['TELLER_DATA_DIR'] ?? path.join(os.homedir(), '.local', 'share', 'teller');
  const configPath = path.join(configDir, 'config.json');

  if (!fs.existsSync(configPath)) {
    throw new ConfigError(`Missing ${configPath}.\n${setupInstructions(configDir)}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (cause) {
    throw new ConfigError(`Unparseable JSON in ${configPath}`, { cause });
  }

  const parsed = ConfigFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(`Invalid ${configPath}: ${parsed.error.message}`);
  }

  fs.mkdirSync(dataDir, { recursive: true });

  return {
    applicationId: parsed.data.applicationId,
    environment: parsed.data.environment,
    configDir,
    certPath: path.join(configDir, 'certificate.pem'),
    keyPath: path.join(configDir, 'private_key.pem'),
    dbPath: path.join(dataDir, 'teller.db'),
  };
}

export function certsPresent(cfg: TellerConfig): boolean {
  return fs.existsSync(cfg.certPath) && fs.existsSync(cfg.keyPath);
}
```

- [ ] **Step 5: Run tests, verify pass**

```bash
pnpm vitest run tests/config.test.ts
```

Expected: 4 passed.

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm typecheck
git add src/core/types.ts src/core/config.ts tests/config.test.ts
git commit -m "feat: teller wire types and config loading"
```

---

### Task 3: SQLite layer

**Files:**
- Create: `src/core/db.ts`
- Test: `tests/db.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks (standalone)
- Produces (all consumed by sync/queries/cli/mcp):
  - `type Db` (better-sqlite3 Database)
  - `interface EnrollmentRow { id: string; access_token: string; institution: string; created_at: number }`
  - `interface AccountRow { id: string; enrollment_id: string; name: string; institution: string; type: 'depository' | 'credit'; subtype: string | null; last_four: string; currency: string; status: string; available_balance: number | null; ledger_balance: number | null; last_synced_at: number | null }`
  - `type AccountUpsert = Omit<AccountRow, 'last_synced_at'>`
  - `interface TransactionRow { id: string; account_id: string; date: string; description: string; amount: number; category: string | null; counterparty: string | null; status: string; type: string; running_balance: number | null }`
  - `openDb(dbPath: string): Db`
  - `upsertEnrollment(db: Db, row: EnrollmentRow): void`
  - `listEnrollments(db: Db): EnrollmentRow[]`
  - `upsertAccount(db: Db, row: AccountUpsert): void` — must NOT touch `last_synced_at`
  - `setAccountSynced(db: Db, accountId: string, ts: number): void`
  - `listAccountRows(db: Db): AccountRow[]`
  - `upsertTransactions(db: Db, rows: TransactionRow[]): { inserted: number; updated: number }`
  - `knownTransactionIds(db: Db, ids: string[]): Set<string>`
  - `countTransactions(db: Db, accountId: string): number`

- [ ] **Step 1: Write failing tests — `tests/db.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import {
  countTransactions,
  knownTransactionIds,
  listAccountRows,
  listEnrollments,
  openDb,
  setAccountSynced,
  upsertAccount,
  upsertEnrollment,
  upsertTransactions,
  type AccountUpsert,
  type TransactionRow,
} from '../src/core/db.js';

const enrollment = {
  id: 'enr_1',
  access_token: 'token_abc',
  institution: 'Chase',
  created_at: 1_700_000_000_000,
};

const account: AccountUpsert = {
  id: 'acc_1',
  enrollment_id: 'enr_1',
  name: 'Total Checking',
  institution: 'Chase',
  type: 'depository',
  subtype: 'checking',
  last_four: '4821',
  currency: 'USD',
  status: 'open',
  available_balance: 1200.5,
  ledger_balance: 1250.0,
};

function txn(id: string, over: Partial<TransactionRow> = {}): TransactionRow {
  return {
    id,
    account_id: 'acc_1',
    date: '2026-07-01',
    description: 'COSTCO WHSE',
    amount: -52.13,
    category: 'groceries',
    counterparty: 'Costco',
    status: 'posted',
    type: 'card_payment',
    running_balance: null,
    ...over,
  };
}

function freshDb() {
  const db = openDb(':memory:');
  upsertEnrollment(db, enrollment);
  upsertAccount(db, account);
  return db;
}

describe('db', () => {
  it('round-trips enrollments and updates on conflict', () => {
    const db = freshDb();
    upsertEnrollment(db, { ...enrollment, access_token: 'token_new' });
    const rows = listEnrollments(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.access_token).toBe('token_new');
  });

  it('upsertAccount preserves last_synced_at across re-upsert', () => {
    const db = freshDb();
    setAccountSynced(db, 'acc_1', 123456);
    upsertAccount(db, { ...account, available_balance: 900 });
    const rows = listAccountRows(db);
    expect(rows[0]?.available_balance).toBe(900);
    expect(rows[0]?.last_synced_at).toBe(123456);
  });

  it('upsertTransactions reports inserted vs updated and updates in place', () => {
    const db = freshDb();
    const first = upsertTransactions(db, [txn('t1', { status: 'pending' }), txn('t2')]);
    expect(first).toEqual({ inserted: 2, updated: 0 });
    const second = upsertTransactions(db, [txn('t1', { status: 'posted', amount: -55.0 })]);
    expect(second).toEqual({ inserted: 0, updated: 1 });
    expect(countTransactions(db, 'acc_1')).toBe(2);
  });

  it('knownTransactionIds returns only existing ids', () => {
    const db = freshDb();
    upsertTransactions(db, [txn('t1')]);
    const known = knownTransactionIds(db, ['t1', 't2']);
    expect(known.has('t1')).toBe(true);
    expect(known.has('t2')).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests, verify failure**

```bash
pnpm vitest run tests/db.test.ts
```

Expected: FAIL — cannot resolve `../src/core/db.js`.

- [ ] **Step 3: Write `src/core/db.ts`**

```ts
import fs from 'node:fs';
import Database from 'better-sqlite3';

export type Db = Database.Database;

export interface EnrollmentRow {
  id: string;
  access_token: string;
  institution: string;
  created_at: number;
}

export interface AccountRow {
  id: string;
  enrollment_id: string;
  name: string;
  institution: string;
  type: 'depository' | 'credit';
  subtype: string | null;
  last_four: string;
  currency: string;
  status: string;
  available_balance: number | null;
  ledger_balance: number | null;
  last_synced_at: number | null;
}

export type AccountUpsert = Omit<AccountRow, 'last_synced_at'>;

export interface TransactionRow {
  id: string;
  account_id: string;
  date: string;
  description: string;
  amount: number;
  category: string | null;
  counterparty: string | null;
  status: string;
  type: string;
  running_balance: number | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS enrollments (
  id            TEXT PRIMARY KEY,
  access_token  TEXT NOT NULL,
  institution   TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS accounts (
  id                 TEXT PRIMARY KEY,
  enrollment_id      TEXT NOT NULL REFERENCES enrollments(id),
  name               TEXT NOT NULL,
  institution        TEXT NOT NULL,
  type               TEXT NOT NULL,
  subtype            TEXT,
  last_four          TEXT NOT NULL,
  currency           TEXT NOT NULL,
  status             TEXT NOT NULL,
  available_balance  REAL,
  ledger_balance     REAL,
  last_synced_at     INTEGER
);
CREATE TABLE IF NOT EXISTS transactions (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES accounts(id),
  date            TEXT NOT NULL,
  description     TEXT NOT NULL,
  amount          REAL NOT NULL,
  category        TEXT,
  counterparty    TEXT,
  status          TEXT NOT NULL,
  type            TEXT NOT NULL,
  running_balance REAL
);
CREATE INDEX IF NOT EXISTS idx_txn_account_date ON transactions(account_id, date);
CREATE INDEX IF NOT EXISTS idx_txn_date ON transactions(date);
CREATE INDEX IF NOT EXISTS idx_txn_category ON transactions(category);
`;

export function openDb(dbPath: string): Db {
  const fresh = dbPath !== ':memory:' && !fs.existsSync(dbPath);
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  if (fresh) fs.chmodSync(dbPath, 0o600);
  return db;
}

export function upsertEnrollment(db: Db, row: EnrollmentRow): void {
  db.prepare(
    `INSERT INTO enrollments (id, access_token, institution, created_at)
     VALUES (@id, @access_token, @institution, @created_at)
     ON CONFLICT(id) DO UPDATE SET
       access_token = excluded.access_token,
       institution  = excluded.institution`,
  ).run(row);
}

export function listEnrollments(db: Db): EnrollmentRow[] {
  return db.prepare('SELECT * FROM enrollments ORDER BY created_at').all() as EnrollmentRow[];
}

export function upsertAccount(db: Db, row: AccountUpsert): void {
  db.prepare(
    `INSERT INTO accounts (
       id, enrollment_id, name, institution, type, subtype, last_four,
       currency, status, available_balance, ledger_balance, last_synced_at
     ) VALUES (
       @id, @enrollment_id, @name, @institution, @type, @subtype, @last_four,
       @currency, @status, @available_balance, @ledger_balance, NULL
     )
     ON CONFLICT(id) DO UPDATE SET
       enrollment_id     = excluded.enrollment_id,
       name              = excluded.name,
       institution       = excluded.institution,
       type              = excluded.type,
       subtype           = excluded.subtype,
       last_four         = excluded.last_four,
       currency          = excluded.currency,
       status            = excluded.status,
       available_balance = excluded.available_balance,
       ledger_balance    = excluded.ledger_balance`,
  ).run(row);
}

export function setAccountSynced(db: Db, accountId: string, ts: number): void {
  db.prepare('UPDATE accounts SET last_synced_at = ? WHERE id = ?').run(ts, accountId);
}

export function listAccountRows(db: Db): AccountRow[] {
  return db
    .prepare('SELECT * FROM accounts ORDER BY institution, name')
    .all() as AccountRow[];
}

export function knownTransactionIds(db: Db, ids: string[]): Set<string> {
  if (ids.length === 0) return new Set();
  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT id FROM transactions WHERE id IN (${placeholders})`)
    .all(...ids) as Array<{ id: string }>;
  return new Set(rows.map(r => r.id));
}

export function countTransactions(db: Db, accountId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM transactions WHERE account_id = ?')
    .get(accountId) as { n: number };
  return row.n;
}

export function upsertTransactions(
  db: Db,
  rows: TransactionRow[],
): { inserted: number; updated: number } {
  if (rows.length === 0) return { inserted: 0, updated: 0 };
  const known = knownTransactionIds(db, rows.map(r => r.id));
  const stmt = db.prepare(
    `INSERT INTO transactions (
       id, account_id, date, description, amount, category, counterparty,
       status, type, running_balance
     ) VALUES (
       @id, @account_id, @date, @description, @amount, @category, @counterparty,
       @status, @type, @running_balance
     )
     ON CONFLICT(id) DO UPDATE SET
       date            = excluded.date,
       description     = excluded.description,
       amount          = excluded.amount,
       category        = excluded.category,
       counterparty    = excluded.counterparty,
       status          = excluded.status,
       type            = excluded.type,
       running_balance = excluded.running_balance`,
  );
  const insertAll = db.transaction((batch: TransactionRow[]) => {
    for (const row of batch) stmt.run(row);
  });
  insertAll(rows);
  const updated = rows.filter(r => known.has(r.id)).length;
  return { inserted: rows.length - updated, updated };
}
```

- [ ] **Step 4: Run tests, verify pass**

```bash
pnpm vitest run tests/db.test.ts
```

Expected: 4 passed.

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm typecheck
git add src/core/db.ts tests/db.test.ts
git commit -m "feat: sqlite schema and data access layer"
```

---

### Task 4: Teller HTTP client (mTLS)

**Files:**
- Create: `src/core/teller-client.ts`
- Test: `tests/teller-client.test.ts`
- Reference: `docs/legacy-reference/tellerClient.ts` (old axios version — endpoints and auth scheme)

**Interfaces:**
- Consumes: `TellerApi`, `TellerAccount`, `TellerBalance`, `TellerTransaction` from `src/core/types.ts`; `TellerConfig`, `certsPresent` from `src/core/config.ts`
- Produces:
  - `class TellerApiError extends Error { status: number | null }`
  - `transactionsPath(accountId: string, opts?: { count?: number; fromId?: string }): string` (pure, exported for tests)
  - `class TellerClient implements TellerApi` with `constructor(opts?: { certPath?: string; keyPath?: string; baseUrl?: string; sleep?: (ms: number) => Promise<void> })`
  - `clientFromConfig(cfg: TellerConfig): TellerClient` — attaches certs for `development`/`production`, throws `ConfigError` if required certs missing; no certs for `sandbox`

- [ ] **Step 1: Write failing tests — `tests/teller-client.test.ts`**

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TellerApiError,
  TellerClient,
  transactionsPath,
} from '../src/core/teller-client.js';

afterEach(() => vi.unstubAllGlobals());

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('transactionsPath', () => {
  it('builds path with count and from_id', () => {
    expect(transactionsPath('acc_1')).toBe('/accounts/acc_1/transactions');
    expect(transactionsPath('acc_1', { count: 1000, fromId: 'txn_9' })).toBe(
      '/accounts/acc_1/transactions?count=1000&from_id=txn_9',
    );
  });
});

describe('TellerClient', () => {
  it('sends token as basic auth username', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, []));
    vi.stubGlobal('fetch', fetchMock);
    const client = new TellerClient();
    await client.listAccounts('tok_1');
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(
      'Basic ' + Buffer.from('tok_1:').toString('base64'),
    );
  });

  it('maps 401 to TellerApiError with status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(401, {})));
    const client = new TellerClient();
    await expect(client.listAccounts('bad')).rejects.toMatchObject({
      name: 'TellerApiError',
      status: 401,
    });
  });

  it('retries once on 429 then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, {}))
      .mockResolvedValueOnce(jsonResponse(200, [{ id: 'acc_1' }]));
    vi.stubGlobal('fetch', fetchMock);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const client = new TellerClient({ sleep });
    const accounts = await client.listAccounts('tok');
    expect(accounts).toHaveLength(1);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it('fails with 429 error when retry also rate-limited', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(429, {})));
    const client = new TellerClient({ sleep: async () => {} });
    await expect(client.listAccounts('tok')).rejects.toMatchObject({ status: 429 });
    expect(() => new TellerApiError('x', 429)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests, verify failure**

```bash
pnpm vitest run tests/teller-client.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/core/teller-client.ts`**

```ts
import fs from 'node:fs';
import { Agent } from 'undici';
import { ConfigError, certsPresent, type TellerConfig } from './config.js';
import type {
  TellerAccount,
  TellerApi,
  TellerBalance,
  TellerTransaction,
} from './types.js';

export class TellerApiError extends Error {
  override readonly name = 'TellerApiError';
  constructor(
    message: string,
    public readonly status: number | null,
  ) {
    super(message);
  }
}

export function transactionsPath(
  accountId: string,
  opts?: { count?: number; fromId?: string },
): string {
  const params = new URLSearchParams();
  if (opts?.count !== undefined) params.set('count', String(opts.count));
  if (opts?.fromId !== undefined) params.set('from_id', opts.fromId);
  const qs = params.toString();
  return `/accounts/${accountId}/transactions${qs ? `?${qs}` : ''}`;
}

const RETRY_DELAY_MS = 2_000;

export class TellerClient implements TellerApi {
  readonly #baseUrl: string;
  readonly #dispatcher: Agent | undefined;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(
    opts: {
      certPath?: string;
      keyPath?: string;
      baseUrl?: string;
      sleep?: (ms: number) => Promise<void>;
    } = {},
  ) {
    this.#baseUrl = opts.baseUrl ?? 'https://api.teller.io';
    this.#sleep = opts.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
    if (opts.certPath !== undefined && opts.keyPath !== undefined) {
      this.#dispatcher = new Agent({
        connect: {
          cert: fs.readFileSync(opts.certPath, 'utf8'),
          key: fs.readFileSync(opts.keyPath, 'utf8'),
        },
      });
    }
  }

  async #get<T>(accessToken: string, apiPath: string): Promise<T> {
    let res = await this.#fetch(accessToken, apiPath);
    if (res.status === 429) {
      await this.#sleep(RETRY_DELAY_MS);
      res = await this.#fetch(accessToken, apiPath);
    }
    if (res.status === 429) {
      throw new TellerApiError('Teller rate limit hit twice; wait a minute and retry', 429);
    }
    if (!res.ok) {
      throw new TellerApiError(`Teller API ${res.status} on ${apiPath}`, res.status);
    }
    return (await res.json()) as T;
  }

  #fetch(accessToken: string, apiPath: string): Promise<Response> {
    const init: RequestInit & { dispatcher?: Agent } = {
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${accessToken}:`).toString('base64'),
        Accept: 'application/json',
      },
    };
    if (this.#dispatcher) init.dispatcher = this.#dispatcher;
    return fetch(this.#baseUrl + apiPath, init as RequestInit).catch(cause => {
      throw new TellerApiError(`Network error calling ${apiPath}: ${String(cause)}`, null);
    });
  }

  listAccounts(accessToken: string): Promise<TellerAccount[]> {
    return this.#get(accessToken, '/accounts');
  }

  getBalance(accessToken: string, accountId: string): Promise<TellerBalance> {
    return this.#get(accessToken, `/accounts/${accountId}/balances`);
  }

  listTransactions(
    accessToken: string,
    accountId: string,
    opts?: { count?: number; fromId?: string },
  ): Promise<TellerTransaction[]> {
    return this.#get(accessToken, transactionsPath(accountId, opts));
  }
}

export function clientFromConfig(cfg: TellerConfig): TellerClient {
  if (cfg.environment === 'sandbox') return new TellerClient();
  if (!certsPresent(cfg)) {
    throw new ConfigError(
      `mTLS certificates required for ${cfg.environment} environment. ` +
        `Expected ${cfg.certPath} and ${cfg.keyPath}.`,
    );
  }
  return new TellerClient({ certPath: cfg.certPath, keyPath: cfg.keyPath });
}
```

- [ ] **Step 4: Run tests, verify pass**

```bash
pnpm vitest run tests/teller-client.test.ts
```

Expected: 5 passed.

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm typecheck
git add src/core/teller-client.ts tests/teller-client.test.ts
git commit -m "feat: undici mTLS teller api client with 429 retry"
```

---

### Task 5: Sync engine

**Files:**
- Create: `src/core/sync.ts`
- Test: `tests/sync.test.ts`
- Reference: `docs/legacy-reference/teller.sync.ts` (old orchestration shape)

**Interfaces:**
- Consumes: `Db`, all db functions and row types (Task 3); `TellerApi`, wire types (Task 2)
- Produces:
  - `toAccountUpsert(a: TellerAccount, balance: TellerBalance | null): AccountUpsert`
  - `toTransactionRow(t: TellerTransaction): TransactionRow`
  - `interface AccountSyncResult { accountId: string; accountName: string; ok: boolean; inserted: number; updated: number; error?: string }`
  - `syncAll(db: Db, api: TellerApi, opts?: { accountId?: string; now?: () => number }): Promise<AccountSyncResult[]>` — iterates every enrollment; per-account failures isolated
- Pagination contract (spec): page size 1000; `from_id` pages backward. Initial sync (0 stored txns for account) drains until short/empty page. Incremental sync stops after upserting a page whose ids are all already known.

- [ ] **Step 1: Write failing tests — `tests/sync.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import {
  countTransactions,
  listAccountRows,
  openDb,
  upsertEnrollment,
  upsertTransactions,
} from '../src/core/db.js';
import { syncAll, toTransactionRow } from '../src/core/sync.js';
import type {
  TellerAccount,
  TellerApi,
  TellerBalance,
  TellerTransaction,
} from '../src/core/types.js';

function account(id: string): TellerAccount {
  return {
    id,
    enrollment_id: 'enr_1',
    name: `Account ${id}`,
    type: 'depository',
    subtype: 'checking',
    last_four: '1111',
    currency: 'USD',
    status: 'open',
    institution: { id: 'chase', name: 'Chase' },
  };
}

function wireTxn(id: string, over: Partial<TellerTransaction> = {}): TellerTransaction {
  return {
    id,
    account_id: 'acc_1',
    date: '2026-07-01',
    description: 'COFFEE',
    amount: '-4.50',
    status: 'posted',
    type: 'card_payment',
    running_balance: null,
    details: { processing_status: 'complete', category: 'dining', counterparty: { name: 'Blue Bottle' } },
    ...over,
  };
}

const balance: TellerBalance = { account_id: 'acc_1', available: '100.00', ledger: '100.00' };

/** Fake API: `pages` maps accountId -> array of pages returned in order per call. */
function fakeApi(overrides: Partial<TellerApi> & { pages?: Record<string, TellerTransaction[][]> }): TellerApi {
  const cursors: Record<string, number> = {};
  return {
    listAccounts: overrides.listAccounts ?? (async () => [account('acc_1')]),
    getBalance: overrides.getBalance ?? (async () => balance),
    listTransactions:
      overrides.listTransactions ??
      (async (_tok, accountId) => {
        const pages = overrides.pages?.[accountId] ?? [[]];
        const i = cursors[accountId] ?? 0;
        cursors[accountId] = i + 1;
        return pages[i] ?? [];
      }),
  };
}

function dbWithEnrollment() {
  const db = openDb(':memory:');
  upsertEnrollment(db, { id: 'enr_1', access_token: 'tok', institution: 'Chase', created_at: 1 });
  return db;
}

describe('toTransactionRow', () => {
  it('parses amount string and flattens counterparty', () => {
    const row = toTransactionRow(wireTxn('t1'));
    expect(row.amount).toBe(-4.5);
    expect(row.counterparty).toBe('Blue Bottle');
    expect(row.category).toBe('dining');
  });
});

describe('syncAll', () => {
  it('initial sync drains all pages backward', async () => {
    const db = dbWithEnrollment();
    const pageA = [wireTxn('t3'), wireTxn('t2')];
    const pageB = [wireTxn('t1')];
    const api = fakeApi({ pages: { acc_1: [pageA, pageB, []] } });
    const results = await syncAll(db, api, { now: () => 999 });
    expect(results[0]).toMatchObject({ ok: true, inserted: 3, updated: 0 });
    expect(countTransactions(db, 'acc_1')).toBe(3);
    expect(listAccountRows(db)[0]?.last_synced_at).toBe(999);
    expect(listAccountRows(db)[0]?.available_balance).toBe(100);
  });

  it('incremental sync stops when a page is fully known', async () => {
    const db = dbWithEnrollment();
    const api1 = fakeApi({ pages: { acc_1: [[wireTxn('t1', { status: 'pending' })], []] } });
    await syncAll(db, api1);
    let calls = 0;
    const api2 = fakeApi({
      listTransactions: async () => {
        calls += 1;
        return [wireTxn('t2'), wireTxn('t1', { status: 'posted' })];
      },
    });
    const results = await syncAll(db, api2);
    // page contained known id t1 -> upsert both, but t1 was known so page not "all new"; drain
    // continues only while pages contain unknown ids AND page was full; this page is short of
    // 1000 so sync stops after one call either way.
    expect(calls).toBe(1);
    expect(results[0]).toMatchObject({ ok: true, inserted: 1, updated: 1 });
  });

  it('isolates per-account failures', async () => {
    const db = dbWithEnrollment();
    const api = fakeApi({
      listAccounts: async () => [account('acc_1'), account('acc_2')],
      getBalance: async (_tok, id) => {
        if (id === 'acc_2') throw new Error('boom');
        return balance;
      },
      pages: { acc_1: [[wireTxn('t1')], []], acc_2: [[]] },
    });
    const results = await syncAll(db, api);
    expect(results).toHaveLength(2);
    expect(results.find(r => r.accountId === 'acc_1')?.ok).toBe(true);
    const failed = results.find(r => r.accountId === 'acc_2');
    expect(failed?.ok).toBe(false);
    expect(failed?.error).toContain('boom');
  });

  it('filters to a single account when opts.accountId given', async () => {
    const db = dbWithEnrollment();
    const api = fakeApi({
      listAccounts: async () => [account('acc_1'), account('acc_2')],
      pages: { acc_1: [[wireTxn('t1')], []], acc_2: [[wireTxn('t9', { account_id: 'acc_2' })], []] },
    });
    const results = await syncAll(db, api, { accountId: 'acc_2' });
    expect(results).toHaveLength(1);
    expect(results[0]?.accountId).toBe('acc_2');
  });
});
```

- [ ] **Step 2: Run tests, verify failure**

```bash
pnpm vitest run tests/sync.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/core/sync.ts`**

```ts
import {
  countTransactions,
  knownTransactionIds,
  listEnrollments,
  setAccountSynced,
  upsertAccount,
  upsertTransactions,
  type AccountUpsert,
  type Db,
  type TransactionRow,
} from './db.js';
import type {
  TellerAccount,
  TellerApi,
  TellerBalance,
  TellerTransaction,
} from './types.js';

const PAGE_SIZE = 1000;

export interface AccountSyncResult {
  accountId: string;
  accountName: string;
  ok: boolean;
  inserted: number;
  updated: number;
  error?: string;
}

function parseMoney(value: string | null): number | null {
  if (value === null) return null;
  const n = Number.parseFloat(value);
  return Number.isNaN(n) ? null : n;
}

export function toAccountUpsert(a: TellerAccount, balance: TellerBalance | null): AccountUpsert {
  return {
    id: a.id,
    enrollment_id: a.enrollment_id,
    name: a.name,
    institution: a.institution.name,
    type: a.type,
    subtype: a.subtype ?? null,
    last_four: a.last_four,
    currency: a.currency,
    status: a.status,
    available_balance: balance ? parseMoney(balance.available) : null,
    ledger_balance: balance ? parseMoney(balance.ledger) : null,
  };
}

export function toTransactionRow(t: TellerTransaction): TransactionRow {
  return {
    id: t.id,
    account_id: t.account_id,
    date: t.date,
    description: t.description,
    amount: Number.parseFloat(t.amount),
    category: t.details.category ?? null,
    counterparty: t.details.counterparty?.name ?? null,
    status: t.status,
    type: t.type,
    running_balance: parseMoney(t.running_balance),
  };
}

async function syncAccount(
  db: Db,
  api: TellerApi,
  accessToken: string,
  tellerAccount: TellerAccount,
  now: () => number,
): Promise<AccountSyncResult> {
  const base = { accountId: tellerAccount.id, accountName: tellerAccount.name };
  try {
    const balance = await api.getBalance(accessToken, tellerAccount.id);
    upsertAccount(db, toAccountUpsert(tellerAccount, balance));

    const isInitial = countTransactions(db, tellerAccount.id) === 0;
    let inserted = 0;
    let updated = 0;
    let fromId: string | undefined;

    for (;;) {
      const opts: { count: number; fromId?: string } = { count: PAGE_SIZE };
      if (fromId !== undefined) opts.fromId = fromId;
      const page = await api.listTransactions(accessToken, tellerAccount.id, opts);
      if (page.length === 0) break;

      const known = knownTransactionIds(db, page.map(t => t.id));
      const counts = upsertTransactions(db, page.map(toTransactionRow));
      inserted += counts.inserted;
      updated += counts.updated;

      const pageFullyKnown = page.every(t => known.has(t.id));
      if (!isInitial && pageFullyKnown) break; // caught up to existing history
      if (page.length < PAGE_SIZE) break; // no older data left
      const last = page[page.length - 1];
      if (last === undefined) break;
      fromId = last.id;
    }

    setAccountSynced(db, tellerAccount.id, now());
    return { ...base, ok: true, inserted, updated };
  } catch (error) {
    return {
      ...base,
      ok: false,
      inserted: 0,
      updated: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function syncAll(
  db: Db,
  api: TellerApi,
  // `| undefined` members: callers pass through optional values under exactOptionalPropertyTypes
  opts: { accountId?: string | undefined; now?: (() => number) | undefined } = {},
): Promise<AccountSyncResult[]> {
  const now = opts.now ?? Date.now;
  const results: AccountSyncResult[] = [];
  for (const enrollment of listEnrollments(db)) {
    let accounts: TellerAccount[];
    try {
      accounts = await api.listAccounts(enrollment.access_token);
    } catch (error) {
      results.push({
        accountId: `enrollment:${enrollment.id}`,
        accountName: enrollment.institution,
        ok: false,
        inserted: 0,
        updated: 0,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    for (const acct of accounts) {
      if (opts.accountId !== undefined && acct.id !== opts.accountId) continue;
      results.push(await syncAccount(db, api, enrollment.access_token, acct, now));
    }
  }
  return results;
}
```

- [ ] **Step 4: Run tests, verify pass**

```bash
pnpm vitest run tests/sync.test.ts
```

Expected: 5 passed.

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm typecheck
git add src/core/sync.ts tests/sync.test.ts
git commit -m "feat: paginated sync engine with per-account error isolation"
```

---

### Task 6: Query layer

**Files:**
- Create: `src/core/queries.ts`
- Test: `tests/queries.test.ts`, `tests/helpers.ts`

**Interfaces:**
- Consumes: `Db`, row types, `listAccountRows` (Task 3); `TellerConfig`, `certsPresent` (Task 2)
- Produces (consumed by cli/mcp):
  - `interface QueryMeta { last_synced_at: number | null; stale: boolean }` (stale = null or older than 24h)
  - `listAccounts(db: Db, now?: () => number): { accounts: AccountRow[]; meta: QueryMeta }`
  - `interface TxnFilters { accountId?, from?, to?, category?, search?, status? ('posted'|'pending'), limit?, offset? }` — every optional member typed `| undefined` (see code) for exactOptionalPropertyTypes compatibility
  - `listTransactions(db: Db, f?: TxnFilters, now?: () => number): { transactions: TransactionRow[]; total: number; meta: QueryMeta }` — default limit 100, ordered by date DESC
  - `type SpendingGroupBy = 'category' | 'merchant' | 'month' | 'account'`
  - `interface SpendingFilters { from: string; to: string; groupBy: SpendingGroupBy; accountId?: string; includePending?: boolean; includeInflows?: boolean }`
  - `interface SpendingGroup { key: string; total: number; count: number; share: number }` — `total` is positive (abs of spend), `share` in [0,1]
  - `spendingSummary(db: Db, f: SpendingFilters, now?: () => number): { groups: SpendingGroup[]; grandTotal: number; meta: QueryMeta }`
  - `authStatus(db: Db, cfg: TellerConfig): { environment: string; certsPresent: boolean; enrollments: Array<{ id: string; institution: string; accountCount: number }> }`

- [ ] **Step 1: Write `tests/helpers.ts`** (seed fixture shared by queries/mcp tests)

```ts
import {
  openDb,
  setAccountSynced,
  upsertAccount,
  upsertEnrollment,
  upsertTransactions,
  type Db,
  type TransactionRow,
} from '../src/core/db.js';

export const NOW = Date.UTC(2026, 6, 16); // 2026-07-16

export function seedDb(): Db {
  const db = openDb(':memory:');
  upsertEnrollment(db, { id: 'enr_1', access_token: 'tok', institution: 'Chase', created_at: 1 });
  upsertAccount(db, {
    id: 'acc_1', enrollment_id: 'enr_1', name: 'Checking', institution: 'Chase',
    type: 'depository', subtype: 'checking', last_four: '1111', currency: 'USD',
    status: 'open', available_balance: 500, ledger_balance: 500,
  });
  upsertAccount(db, {
    id: 'acc_2', enrollment_id: 'enr_1', name: 'Card', institution: 'Chase',
    type: 'credit', subtype: 'credit_card', last_four: '2222', currency: 'USD',
    status: 'open', available_balance: -200, ledger_balance: -200,
  });
  setAccountSynced(db, 'acc_1', NOW - 60_000); // 1 min ago
  setAccountSynced(db, 'acc_2', NOW - 60_000);
  const t = (id: string, over: Partial<TransactionRow>): TransactionRow => ({
    id, account_id: 'acc_1', date: '2026-07-10', description: 'X', amount: -10,
    category: null, counterparty: null, status: 'posted', type: 'card_payment',
    running_balance: null, ...over,
  });
  upsertTransactions(db, [
    t('t1', { amount: -50, category: 'groceries', counterparty: 'Costco', date: '2026-07-01' }),
    t('t2', { amount: -30, category: 'groceries', counterparty: 'Safeway', date: '2026-07-05' }),
    t('t3', { amount: -20, category: 'dining', counterparty: 'Blue Bottle', date: '2026-06-20' }),
    t('t4', { amount: 2000, category: 'income', counterparty: 'Employer', date: '2026-07-01' }),
    t('t5', { amount: -99, category: 'dining', counterparty: 'Sushi', status: 'pending', date: '2026-07-15' }),
    t('t6', { amount: -40, category: 'travel', counterparty: 'BART', account_id: 'acc_2', date: '2026-07-08' }),
  ]);
  return db;
}
```

- [ ] **Step 2: Write failing tests — `tests/queries.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { setAccountSynced } from '../src/core/db.js';
import { listAccounts, listTransactions, spendingSummary } from '../src/core/queries.js';
import { NOW, seedDb } from './helpers.js';

describe('listAccounts', () => {
  it('returns accounts with fresh meta', () => {
    const { accounts, meta } = listAccounts(seedDb(), () => NOW);
    expect(accounts).toHaveLength(2);
    expect(meta.stale).toBe(false);
    expect(meta.last_synced_at).toBe(NOW - 60_000);
  });

  it('flags stale when oldest sync exceeds 24h', () => {
    const db = seedDb();
    setAccountSynced(db, 'acc_2', NOW - 25 * 3600 * 1000);
    expect(listAccounts(db, () => NOW).meta.stale).toBe(true);
  });
});

describe('listTransactions', () => {
  it('filters by date range, account, and text search', () => {
    const db = seedDb();
    const july = listTransactions(db, { from: '2026-07-01', to: '2026-07-31' }, () => NOW);
    expect(july.total).toBe(5);
    const acc2 = listTransactions(db, { accountId: 'acc_2' }, () => NOW);
    expect(acc2.transactions.map(t => t.id)).toEqual(['t6']);
    const costco = listTransactions(db, { search: 'costco' }, () => NOW);
    expect(costco.transactions.map(t => t.id)).toEqual(['t1']);
  });

  it('orders date DESC and respects limit/offset with total intact', () => {
    const db = seedDb();
    const page = listTransactions(db, { limit: 2, offset: 1 }, () => NOW);
    expect(page.total).toBe(6);
    expect(page.transactions).toHaveLength(2);
    expect(page.transactions[0]?.date! >= page.transactions[1]?.date!).toBe(true);
  });
});

describe('spendingSummary', () => {
  it('groups spend by category, excluding pending and inflows by default', () => {
    const db = seedDb();
    const { groups, grandTotal } = spendingSummary(
      db,
      { from: '2026-06-01', to: '2026-07-31', groupBy: 'category' },
      () => NOW,
    );
    // spend: groceries 80, travel 40, dining 20 (t5 pending excluded, t4 inflow excluded)
    expect(grandTotal).toBe(140);
    expect(groups[0]).toMatchObject({ key: 'groceries', total: 80, count: 2 });
    expect(groups[0]?.share).toBeCloseTo(80 / 140);
  });

  it('groups by month and can include pending', () => {
    const db = seedDb();
    const { groups } = spendingSummary(
      db,
      { from: '2026-06-01', to: '2026-07-31', groupBy: 'month', includePending: true },
      () => NOW,
    );
    const july = groups.find(g => g.key === '2026-07');
    expect(july?.total).toBe(219); // 50+30+99+40
  });

  it('groups merchants with unknown fallback', () => {
    const db = seedDb();
    const { groups } = spendingSummary(
      db,
      { from: '2026-06-01', to: '2026-07-31', groupBy: 'merchant' },
      () => NOW,
    );
    expect(groups.map(g => g.key)).toContain('Costco');
  });
});
```

- [ ] **Step 3: Run tests, verify failure**

```bash
pnpm vitest run tests/queries.test.ts
```

Expected: FAIL — `queries.js` not found.

- [ ] **Step 4: Write `src/core/queries.ts`**

```ts
import { certsPresent, type TellerConfig } from './config.js';
import { listAccountRows, type AccountRow, type Db, type TransactionRow } from './db.js';

const STALE_MS = 24 * 3600 * 1000;

export interface QueryMeta {
  last_synced_at: number | null;
  stale: boolean;
}

function metaFor(db: Db, now: () => number, accountId?: string): QueryMeta {
  const rows = listAccountRows(db).filter(a => accountId === undefined || a.id === accountId);
  if (rows.length === 0) return { last_synced_at: null, stale: true };
  const syncTimes = rows.map(a => a.last_synced_at);
  if (syncTimes.some(t => t === null)) return { last_synced_at: null, stale: true };
  const oldest = Math.min(...(syncTimes as number[]));
  return { last_synced_at: oldest, stale: now() - oldest > STALE_MS };
}

export function listAccounts(
  db: Db,
  now: () => number = Date.now,
): { accounts: AccountRow[]; meta: QueryMeta } {
  return { accounts: listAccountRows(db), meta: metaFor(db, now) };
}

// All members include `| undefined` so zod-parsed / commander-derived objects
// assign cleanly under exactOptionalPropertyTypes.
export interface TxnFilters {
  accountId?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  category?: string | undefined;
  search?: string | undefined;
  status?: 'posted' | 'pending' | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

function txnWhere(f: TxnFilters): { where: string; params: Record<string, unknown> } {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};
  if (f.accountId !== undefined) { clauses.push('account_id = @accountId'); params['accountId'] = f.accountId; }
  if (f.from !== undefined) { clauses.push('date >= @from'); params['from'] = f.from; }
  if (f.to !== undefined) { clauses.push('date <= @to'); params['to'] = f.to; }
  if (f.category !== undefined) { clauses.push('category = @category'); params['category'] = f.category; }
  if (f.status !== undefined) { clauses.push('status = @status'); params['status'] = f.status; }
  if (f.search !== undefined) {
    clauses.push("(description LIKE @search OR counterparty LIKE @search)");
    params['search'] = `%${f.search}%`;
  }
  return { where: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

export function listTransactions(
  db: Db,
  f: TxnFilters = {},
  now: () => number = Date.now,
): { transactions: TransactionRow[]; total: number; meta: QueryMeta } {
  const { where, params } = txnWhere(f);
  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM transactions ${where}`).get(params) as { n: number }
  ).n;
  const transactions = db
    .prepare(
      `SELECT * FROM transactions ${where}
       ORDER BY date DESC, id DESC LIMIT @limit OFFSET @offset`,
    )
    .all({ ...params, limit: f.limit ?? 100, offset: f.offset ?? 0 }) as TransactionRow[];
  return { transactions, total, meta: metaFor(db, now, f.accountId) };
}

export type SpendingGroupBy = 'category' | 'merchant' | 'month' | 'account';

export interface SpendingFilters {
  from: string;
  to: string;
  groupBy: SpendingGroupBy;
  accountId?: string | undefined;
  includePending?: boolean | undefined;
  includeInflows?: boolean | undefined;
}

export interface SpendingGroup {
  key: string;
  total: number;
  count: number;
  share: number;
}

const GROUP_EXPR: Record<SpendingGroupBy, string> = {
  category: "COALESCE(category, 'uncategorized')",
  merchant: "COALESCE(NULLIF(counterparty, ''), 'unknown')",
  month: 'substr(date, 1, 7)',
  account: 'account_id',
};

export function spendingSummary(
  db: Db,
  f: SpendingFilters,
  now: () => number = Date.now,
): { groups: SpendingGroup[]; grandTotal: number; meta: QueryMeta } {
  const clauses = ['date >= @from', 'date <= @to'];
  const params: Record<string, unknown> = { from: f.from, to: f.to };
  if (f.accountId !== undefined) { clauses.push('account_id = @accountId'); params['accountId'] = f.accountId; }
  if (f.includePending !== true) clauses.push("status = 'posted'");
  // Spend = negative amounts (Teller sign convention). Sole definition of "spend".
  if (f.includeInflows !== true) clauses.push('amount < 0');

  const rows = db
    .prepare(
      `SELECT ${GROUP_EXPR[f.groupBy]} AS key,
              SUM(CASE WHEN amount < 0 THEN -amount ELSE amount END) AS total,
              COUNT(*) AS count
       FROM transactions
       WHERE ${clauses.join(' AND ')}
       GROUP BY key
       ORDER BY total DESC`,
    )
    .all(params) as Array<{ key: string; total: number; count: number }>;

  const grandTotal = rows.reduce((sum, r) => sum + r.total, 0);
  const groups = rows.map(r => ({
    ...r,
    share: grandTotal === 0 ? 0 : r.total / grandTotal,
  }));
  return { groups, grandTotal, meta: metaFor(db, now, f.accountId) };
}

export function authStatus(
  db: Db,
  cfg: TellerConfig,
): {
  environment: string;
  certsPresent: boolean;
  enrollments: Array<{ id: string; institution: string; accountCount: number }>;
} {
  const rows = db
    .prepare(
      `SELECT e.id, e.institution, COUNT(a.id) AS accountCount
       FROM enrollments e LEFT JOIN accounts a ON a.enrollment_id = e.id
       GROUP BY e.id ORDER BY e.created_at`,
    )
    .all() as Array<{ id: string; institution: string; accountCount: number }>;
  return { environment: cfg.environment, certsPresent: certsPresent(cfg), enrollments: rows };
}
```

- [ ] **Step 5: Run tests, verify pass**

```bash
pnpm vitest run tests/queries.test.ts
```

Expected: 7 passed.

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm typecheck
git add src/core/queries.ts tests/queries.test.ts tests/helpers.ts
git commit -m "feat: query layer with staleness meta and spending rollups"
```

---

### Task 7: Enrollment auth server

**Files:**
- Create: `src/auth/server.ts`
- Test: `tests/auth-server.test.ts`

**Interfaces:**
- Consumes: nothing from core (standalone; CLI wires it up in Task 8)
- Produces:
  - `interface AuthResult { accessToken: string; enrollmentId: string; institutionName: string }`
  - `connectPageHtml(applicationId: string, environment: string): string`
  - `startAuthServer(opts: { applicationId: string; environment: string; port?: number; timeoutMs?: number }): { url: string; result: Promise<AuthResult>; close: () => void }` — `port` 0 allowed (ephemeral, for tests); default port 8021, default timeout 300000 ms. Server always closes itself after resolve/reject.

- [ ] **Step 1: Write failing tests — `tests/auth-server.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { connectPageHtml, startAuthServer } from '../src/auth/server.js';

const callbackBody = {
  accessToken: 'tok_live',
  enrollment: { id: 'enr_9', institution: { name: 'Chase' } },
};

describe('connectPageHtml', () => {
  it('embeds application id, environment, and connect.js', () => {
    const html = connectPageHtml('app_42', 'development');
    expect(html).toContain('app_42');
    expect(html).toContain('development');
    expect(html).toContain('cdn.teller.io/connect/connect.js');
  });
});

describe('startAuthServer', () => {
  it('serves the connect page and resolves on valid callback', async () => {
    const server = startAuthServer({ applicationId: 'app_42', environment: 'development', port: 0 });
    const page = await fetch(server.url);
    expect(await page.text()).toContain('app_42');
    const res = await fetch(`${server.url}callback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(callbackBody),
    });
    expect(res.status).toBe(200);
    await expect(server.result).resolves.toEqual({
      accessToken: 'tok_live',
      enrollmentId: 'enr_9',
      institutionName: 'Chase',
    });
  });

  it('rejects malformed callbacks with 400 and keeps waiting', async () => {
    const server = startAuthServer({ applicationId: 'app_42', environment: 'development', port: 0 });
    const res = await fetch(`${server.url}callback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nope: true }),
    });
    expect(res.status).toBe(400);
    server.close();
    await expect(server.result).rejects.toThrow(/closed|timed out/i);
  });

  it('times out when no callback arrives', async () => {
    const server = startAuthServer({
      applicationId: 'app_42',
      environment: 'development',
      port: 0,
      timeoutMs: 50,
    });
    await expect(server.result).rejects.toThrow(/timed out/i);
  });
});
```

- [ ] **Step 2: Run tests, verify failure**

```bash
pnpm vitest run tests/auth-server.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/auth/server.ts`**

```ts
import http from 'node:http';
import { z } from 'zod';

export interface AuthResult {
  accessToken: string;
  enrollmentId: string;
  institutionName: string;
}

const CallbackSchema = z.object({
  accessToken: z.string().min(1),
  enrollment: z.object({
    id: z.string().min(1),
    institution: z.object({ name: z.string().min(1) }),
  }),
});

export function connectPageHtml(applicationId: string, environment: string): string {
  const config = JSON.stringify({ applicationId, environment, selectAccount: 'multiple' });
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Teller — Link a bank</title>
  <script src="https://cdn.teller.io/connect/connect.js"></script>
</head>
<body style="font-family: system-ui; display: grid; place-items: center; min-height: 90vh">
  <div id="status"><h2>Opening Teller Connect…</h2></div>
  <script>
    const setup = Object.assign({}, ${config}, {
      onSuccess: function (enrollment) {
        fetch('/callback', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(enrollment),
        }).then(function () {
          document.getElementById('status').innerHTML =
            '<h2>Bank linked. You can close this tab and return to the terminal.</h2>';
        });
      },
      onExit: function () {
        document.getElementById('status').innerHTML =
          '<h2>Teller Connect closed. Re-run <code>teller auth</code> to try again.</h2>';
      },
    });
    TellerConnect.setup(setup).open();
  </script>
</body>
</html>`;
}

const DEFAULT_PORT = 8021;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export function startAuthServer(opts: {
  applicationId: string;
  environment: string;
  port?: number;
  timeoutMs?: number;
}): { url: string; result: Promise<AuthResult>; close: () => void } {
  let resolveResult: (r: AuthResult) => void;
  let rejectResult: (e: Error) => void;
  const result = new Promise<AuthResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  let settled = false;
  const settle = (fn: () => void) => {
    if (settled) return;
    settled = true;
    fn();
    clearTimeout(timer);
    server.close();
  };

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(connectPageHtml(opts.applicationId, opts.environment));
      return;
    }
    if (req.method === 'POST' && req.url === '/callback') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          parsed = null;
        }
        const check = CallbackSchema.safeParse(parsed);
        if (!check.success) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid enrollment payload' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        settle(() =>
          resolveResult({
            accessToken: check.data.accessToken,
            enrollmentId: check.data.enrollment.id,
            institutionName: check.data.enrollment.institution.name,
          }),
        );
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const timer = setTimeout(() => {
    settle(() => rejectResult(new Error('Enrollment timed out — no callback received')));
  }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  timer.unref();

  server.listen(opts.port ?? DEFAULT_PORT);
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : (opts.port ?? DEFAULT_PORT);

  return {
    url: `http://localhost:${port}/`,
    result,
    close: () => settle(() => rejectResult(new Error('Auth server closed'))),
  };
}
```

- [ ] **Step 4: Run tests, verify pass**

```bash
pnpm vitest run tests/auth-server.test.ts
```

Expected: 4 passed. (If `server.address()` returns null because listen hasn't bound yet on some platforms, wrap the return-url computation in a `server.once('listening')` wait: change `startAuthServer` to compute the URL lazily via a small exported async variant — but on macOS/Linux `listen()` binds synchronously enough for `address()` after the call in practice with port 0; verify the test passes before restructuring.)

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm typecheck
git add src/auth/server.ts tests/auth-server.test.ts
git commit -m "feat: ephemeral enrollment server serving teller connect"
```

---

### Task 8: CLI

**Files:**
- Create: `src/cli/index.ts`, `src/cli/format.ts`
- Test: `tests/format.test.ts`

**Interfaces:**
- Consumes: everything from `core/` (Tasks 2–6) and `auth/server.ts` (Task 7). Exact imports shown in code below.
- Produces: `teller` executable with subcommands `auth`, `auth status`, `sync`, `accounts`, `transactions`, `spending`; global `--json`. Exit codes: 0 ok, 1 general, 2 config missing, 3 reauth needed.
- `format.ts` produces: `money(n: number | null): string` (e.g. `-52.13` → `"-$52.13"`, null → `"—"`), `formatTable(rows: Array<Record<string, unknown>>): string` (aligned columns, header row from keys, empty-input → `"(none)"`).

- [ ] **Step 1: Write failing tests — `tests/format.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { formatTable, money } from '../src/cli/format.js';

describe('money', () => {
  it('formats dollars with sign and null as em dash', () => {
    expect(money(-52.13)).toBe('-$52.13');
    expect(money(1200.5)).toBe('$1,200.50');
    expect(money(null)).toBe('—');
  });
});

describe('formatTable', () => {
  it('aligns columns under headers', () => {
    const out = formatTable([
      { name: 'Checking', balance: '$500.00' },
      { name: 'Card', balance: '-$200.00' },
    ]);
    const lines = out.split('\n');
    expect(lines[0]).toMatch(/name\s+balance/);
    expect(lines).toHaveLength(3);
  });

  it('handles empty input', () => {
    expect(formatTable([])).toBe('(none)');
  });
});
```

- [ ] **Step 2: Run, verify failure**

```bash
pnpm vitest run tests/format.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/cli/format.ts`**

```ts
export function money(n: number | null): string {
  if (n === null) return '—';
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatTable(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return '(none)';
  const first = rows[0];
  if (first === undefined) return '(none)';
  const keys = Object.keys(first);
  const cell = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
  const widths = keys.map(k =>
    Math.max(k.length, ...rows.map(r => cell(r[k]).length)),
  );
  const line = (vals: string[]): string =>
    vals.map((v, i) => v.padEnd(widths[i] ?? 0)).join('  ').trimEnd();
  return [line(keys), ...rows.map(r => line(keys.map(k => cell(r[k]))))].join('\n');
}
```

- [ ] **Step 4: Run format tests, verify pass**

```bash
pnpm vitest run tests/format.test.ts
```

Expected: 3 passed.

- [ ] **Step 5: Write `src/cli/index.ts`** (no unit tests — verified by smoke test in Step 6; logic lives in core, this is wiring)

```ts
#!/usr/bin/env node
import { exec } from 'node:child_process';
import { Command } from 'commander';
import { startAuthServer } from '../auth/server.js';
import { ConfigError, certsPresent, loadConfig, setupInstructions, type TellerConfig } from '../core/config.js';
import { openDb, upsertEnrollment, type Db } from '../core/db.js';
import { authStatus, listAccounts, listTransactions, spendingSummary, type SpendingGroupBy } from '../core/queries.js';
import { syncAll, type AccountSyncResult } from '../core/sync.js';
import { TellerApiError, clientFromConfig } from '../core/teller-client.js';
import { formatTable, money } from './format.js';

const EXIT_GENERAL = 1;
const EXIT_CONFIG = 2;
const EXIT_REAUTH = 3;

interface Ctx {
  cfg: TellerConfig;
  db: Db;
  json: boolean;
}

function withCtx(program: Command, run: (ctx: Ctx, ...args: never[]) => Promise<void> | void) {
  return async (...args: unknown[]) => {
    const json = Boolean(program.opts()['json']);
    try {
      const cfg = loadConfig();
      const db = openDb(cfg.dbPath);
      await run({ cfg, db, json }, ...(args as never[]));
    } catch (error) {
      handleError(error, json);
    }
  };
}

function handleError(error: unknown, json: boolean): never {
  if (error instanceof ConfigError) {
    process.stderr.write(`${error.message}\n`);
    process.exit(EXIT_CONFIG);
  }
  if (error instanceof TellerApiError && error.status === 401) {
    const msg = 'Teller rejected the access token (401). Re-run `teller auth` for that institution.';
    process.stderr.write(json ? JSON.stringify({ error: msg, needs_reauth: true }) + '\n' : msg + '\n');
    process.exit(EXIT_REAUTH);
  }
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(EXIT_GENERAL);
}

function printSyncResults(results: AccountSyncResult[], json: boolean): void {
  if (json) {
    process.stdout.write(JSON.stringify(results, null, 2) + '\n');
    return;
  }
  process.stdout.write(
    formatTable(
      results.map(r => ({
        account: r.accountName,
        ok: r.ok ? 'yes' : 'NO',
        inserted: r.inserted,
        updated: r.updated,
        error: r.error ?? '',
      })),
    ) + '\n',
  );
  if (results.some(r => !r.ok)) process.exitCode = EXIT_GENERAL;
}

const program = new Command()
  .name('teller')
  .description('Local Teller financial data: sync to SQLite, query from anywhere')
  .option('--json', 'machine-readable JSON output');

const auth = program.command('auth').description('link a bank via Teller Connect');

auth.action(
  withCtx(program, async ({ cfg, db, json }) => {
    if (cfg.environment !== 'sandbox' && !certsPresent(cfg)) {
      throw new ConfigError(
        `Certificates missing for ${cfg.environment}.\n${setupInstructions(cfg.configDir)}`,
      );
    }
    const server = startAuthServer({
      applicationId: cfg.applicationId,
      environment: cfg.environment,
    });
    process.stdout.write(`Opening ${server.url} — complete bank login in the browser.\n`);
    exec(`open ${server.url}`);
    const enrollment = await server.result;
    upsertEnrollment(db, {
      id: enrollment.enrollmentId,
      access_token: enrollment.accessToken,
      institution: enrollment.institutionName,
      created_at: Date.now(),
    });
    process.stdout.write(`Linked ${enrollment.institutionName}. Running initial sync…\n`);
    const results = await syncAll(db, clientFromConfig(cfg));
    printSyncResults(results, json);
  }),
);

auth
  .command('status')
  .description('show enrollments and cert status')
  .action(
    withCtx(program, ({ cfg, db, json }) => {
      const status = authStatus(db, cfg);
      process.stdout.write(
        json
          ? JSON.stringify(status, null, 2) + '\n'
          : `environment: ${status.environment}\ncerts: ${status.certsPresent ? 'present' : 'MISSING'}\n` +
              formatTable(status.enrollments) + '\n',
      );
    }),
  );

program
  .command('sync')
  .description('refresh accounts, balances, and transactions from Teller')
  .option('--account <id>', 'sync a single account')
  .action(
    withCtx(program, async ({ cfg, db, json }, opts: { account?: string }) => {
      const results = await syncAll(db, clientFromConfig(cfg), { accountId: opts.account });
      printSyncResults(results, json);
    }),
  );

program
  .command('accounts')
  .description('list accounts with balances (from local db)')
  .action(
    withCtx(program, ({ db, json }) => {
      const { accounts, meta } = listAccounts(db);
      if (json) {
        process.stdout.write(JSON.stringify({ accounts, meta }, null, 2) + '\n');
        return;
      }
      process.stdout.write(
        formatTable(
          accounts.map(a => ({
            institution: a.institution,
            name: a.name,
            type: a.type,
            last4: a.last_four,
            available: money(a.available_balance),
          })),
        ) + `\n${meta.stale ? 'STALE — run `teller sync`' : 'fresh'}\n`,
      );
    }),
  );

program
  .command('transactions')
  .description('query transactions (from local db)')
  .option('--account <id>')
  .option('--from <date>')
  .option('--to <date>')
  .option('--category <name>')
  .option('--search <text>')
  .option('--limit <n>', 'default 100')
  .action(
    withCtx(
      program,
      ({ db, json }, opts: { account?: string; from?: string; to?: string; category?: string; search?: string; limit?: string }) => {
        const result = listTransactions(db, {
          ...(opts.account !== undefined && { accountId: opts.account }),
          ...(opts.from !== undefined && { from: opts.from }),
          ...(opts.to !== undefined && { to: opts.to }),
          ...(opts.category !== undefined && { category: opts.category }),
          ...(opts.search !== undefined && { search: opts.search }),
          ...(opts.limit !== undefined && { limit: Number(opts.limit) }),
        });
        if (json) {
          process.stdout.write(JSON.stringify(result, null, 2) + '\n');
          return;
        }
        process.stdout.write(
          formatTable(
            result.transactions.map(t => ({
              date: t.date,
              amount: money(t.amount),
              description: t.description,
              category: t.category ?? '',
              status: t.status,
            })),
          ) + `\n${result.transactions.length} of ${result.total} shown\n`,
        );
      },
    ),
  );

program
  .command('spending')
  .description('spending rollup (from local db)')
  .requiredOption('--from <date>')
  .requiredOption('--to <date>')
  .option('--by <group>', 'category|merchant|month|account', 'category')
  .option('--account <id>')
  .action(
    withCtx(
      program,
      ({ db, json }, opts: { from: string; to: string; by: string; account?: string }) => {
        const groupBy = opts.by as SpendingGroupBy;
        if (!['category', 'merchant', 'month', 'account'].includes(groupBy)) {
          throw new Error(`--by must be category|merchant|month|account, got "${opts.by}"`);
        }
        const result = spendingSummary(db, {
          from: opts.from,
          to: opts.to,
          groupBy,
          ...(opts.account !== undefined && { accountId: opts.account }),
        });
        if (json) {
          process.stdout.write(JSON.stringify(result, null, 2) + '\n');
          return;
        }
        process.stdout.write(
          formatTable(
            result.groups.map(g => ({
              [groupBy]: g.key,
              total: money(g.total),
              count: g.count,
              share: `${(g.share * 100).toFixed(1)}%`,
            })),
          ) + `\ntotal: ${money(result.grandTotal)}\n`,
        );
      },
    ),
  );

program.parseAsync().catch(error => handleError(error, Boolean(program.opts()['json'])));
```

- [ ] **Step 6: Smoke test the CLI without config (exit code contract)**

```bash
TELLER_CONFIG_DIR=/tmp/definitely-missing-teller pnpm cli accounts; echo "exit: $?"
```

Expected: setup instructions on stderr, `exit: 2`.

```bash
mkdir -p /tmp/teller-smoke/config /tmp/teller-smoke/data
echo '{ "applicationId": "app_test" }' > /tmp/teller-smoke/config/config.json
TELLER_CONFIG_DIR=/tmp/teller-smoke/config TELLER_DATA_DIR=/tmp/teller-smoke/data pnpm cli accounts
TELLER_CONFIG_DIR=/tmp/teller-smoke/config TELLER_DATA_DIR=/tmp/teller-smoke/data pnpm cli accounts --json
```

Expected: `(none)` + stale notice; then JSON `{ "accounts": [], "meta": { "last_synced_at": null, "stale": true } }`.

- [ ] **Step 7: Typecheck, full test run, commit**

```bash
pnpm typecheck && pnpm test
git add src/cli tests/format.test.ts
git commit -m "feat: teller cli with auth/sync/accounts/transactions/spending"
```

---

### Task 9: MCP server

**Files:**
- Create: `src/mcp/server.ts`, `src/mcp/index.ts`
- Test: `tests/mcp.test.ts`

**Interfaces:**
- Consumes: `Db` + queries (Task 6), `syncAll` (Task 5), `TellerApi` (Task 2), `TellerConfig`/`loadConfig` (Task 2), `clientFromConfig` (Task 4), `authStatus` (Task 6), seed helper (`tests/helpers.ts`)
- Produces:
  - `buildMcpServer(deps: { db: Db; api: TellerApi; cfg: TellerConfig }): McpServer` with tools `list_accounts`, `list_transactions`, `spending_summary`, `sync`, `auth_status`
  - `src/mcp/index.ts` stdio entry (`teller-mcp` bin)
- All tools return `{ content: [{ type: 'text', text: JSON.stringify(result) }] }`; errors return `isError: true` with a message telling the agent what to do (e.g. reauth → "ask the user to run `teller auth`").

- [ ] **Step 1: Write failing tests — `tests/mcp.test.ts`**

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import type { TellerConfig } from '../src/core/config.js';
import type { TellerApi } from '../src/core/types.js';
import { buildMcpServer } from '../src/mcp/server.js';
import { seedDb } from './helpers.js';

const cfg: TellerConfig = {
  applicationId: 'app_test',
  environment: 'development',
  configDir: '/tmp/nope',
  certPath: '/tmp/nope/certificate.pem',
  keyPath: '/tmp/nope/private_key.pem',
  dbPath: ':memory:',
};

const noApi: TellerApi = {
  listAccounts: async () => [],
  getBalance: async () => ({ account_id: 'x', available: null, ledger: null }),
  listTransactions: async () => [],
};

async function connectedClient() {
  const server = buildMcpServer({ db: seedDb(), api: noApi, cfg });
  const client = new Client({ name: 'test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function textOf(result: { content?: unknown }): unknown {
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0]?.text ?? 'null');
}

describe('mcp server', () => {
  it('exposes the five tools', async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name).sort()).toEqual([
      'auth_status',
      'list_accounts',
      'list_transactions',
      'spending_summary',
      'sync',
    ]);
  });

  it('list_accounts returns rows and staleness meta', async () => {
    const client = await connectedClient();
    const result = await client.callTool({ name: 'list_accounts', arguments: {} });
    const data = textOf(result) as { accounts: unknown[]; meta: { stale: boolean } };
    expect(data.accounts).toHaveLength(2);
    expect(typeof data.meta.stale).toBe('boolean');
  });

  it('list_transactions validates and applies filters', async () => {
    const client = await connectedClient();
    const result = await client.callTool({
      name: 'list_transactions',
      arguments: { search: 'costco', limit: 5 },
    });
    const data = textOf(result) as { transactions: Array<{ id: string }> };
    expect(data.transactions.map(t => t.id)).toEqual(['t1']);
  });

  it('spending_summary groups by category', async () => {
    const client = await connectedClient();
    const result = await client.callTool({
      name: 'spending_summary',
      arguments: { from: '2026-06-01', to: '2026-07-31', groupBy: 'category' },
    });
    const data = textOf(result) as { grandTotal: number };
    expect(data.grandTotal).toBe(140);
  });
});
```

- [ ] **Step 2: Run, verify failure**

```bash
pnpm vitest run tests/mcp.test.ts
```

Expected: FAIL — `../src/mcp/server.js` not found.

- [ ] **Step 3: Write `src/mcp/server.ts`**

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { TellerConfig } from '../core/config.js';
import type { Db } from '../core/db.js';
import {
  authStatus,
  listAccounts,
  listTransactions,
  spendingSummary,
} from '../core/queries.js';
import { syncAll } from '../core/sync.js';
import { TellerApiError } from '../core/teller-client.js';
import type { TellerApi } from '../core/types.js';

interface Deps {
  db: Db;
  api: TellerApi;
  cfg: TellerConfig;
}

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

function ok(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function err(error: unknown): ToolResult {
  let message = error instanceof Error ? error.message : String(error);
  if (error instanceof TellerApiError && error.status === 401) {
    message =
      'Teller rejected the stored access token (401). Ask the user to re-link the bank by running `teller auth` in a terminal.';
  }
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

export function buildMcpServer(deps: Deps): McpServer {
  const server = new McpServer({ name: 'teller-local', version: '0.1.0' });

  server.registerTool(
    'list_accounts',
    {
      description:
        'List all linked bank accounts with balances from the local cache. ' +
        'Result meta.stale=true means data is >24h old — consider calling sync first.',
      inputSchema: {},
    },
    async () => {
      try {
        return ok(listAccounts(deps.db));
      } catch (error) {
        return err(error);
      }
    },
  );

  server.registerTool(
    'list_transactions',
    {
      description:
        'Query cached transactions. Amounts follow bank sign convention: spending is negative, income positive. ' +
        'Dates are yyyy-mm-dd. Returns total match count alongside the (paginated) rows.',
      inputSchema: {
        accountId: z.string().optional(),
        from: z.string().optional().describe('inclusive start date yyyy-mm-dd'),
        to: z.string().optional().describe('inclusive end date yyyy-mm-dd'),
        category: z.string().optional(),
        search: z.string().optional().describe('substring match on description/merchant'),
        status: z.enum(['posted', 'pending']).optional(),
        limit: z.number().int().positive().max(1000).optional().describe('default 100'),
        offset: z.number().int().nonnegative().optional(),
      },
    },
    async (args) => {
      try {
        return ok(listTransactions(deps.db, args));
      } catch (error) {
        return err(error);
      }
    },
  );

  server.registerTool(
    'spending_summary',
    {
      description:
        'Aggregate spending (negative amounts only, pending excluded by default) over a date range, ' +
        'grouped by category, merchant, month, or account. Totals are positive dollar amounts.',
      inputSchema: {
        from: z.string().describe('inclusive start date yyyy-mm-dd'),
        to: z.string().describe('inclusive end date yyyy-mm-dd'),
        groupBy: z.enum(['category', 'merchant', 'month', 'account']),
        accountId: z.string().optional(),
        includePending: z.boolean().optional(),
        includeInflows: z.boolean().optional(),
      },
    },
    async (args) => {
      try {
        return ok(spendingSummary(deps.db, args));
      } catch (error) {
        return err(error);
      }
    },
  );

  server.registerTool(
    'sync',
    {
      description:
        'Refresh the local cache from the bank via the Teller API. Call when results show stale: true ' +
        'and current data matters. Takes ~5-30 seconds. Returns per-account insert/update counts.',
      inputSchema: {
        accountId: z.string().optional().describe('sync only this account'),
      },
    },
    async (args) => {
      try {
        const results = await syncAll(deps.db, deps.api, { accountId: args.accountId });
        return ok({ results });
      } catch (error) {
        return err(error);
      }
    },
  );

  server.registerTool(
    'auth_status',
    {
      description:
        'Show linked institutions, account counts, environment, and certificate status. ' +
        'If no enrollments exist, ask the user to run `teller auth` in a terminal — enrollment needs a human at a browser.',
      inputSchema: {},
    },
    async () => {
      try {
        return ok(authStatus(deps.db, deps.cfg));
      } catch (error) {
        return err(error);
      }
    },
  );

  return server;
}
```

- [ ] **Step 4: Write `src/mcp/index.ts`**

```ts
#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from '../core/config.js';
import { openDb } from '../core/db.js';
import { clientFromConfig } from '../core/teller-client.js';
import { buildMcpServer } from './server.js';

const cfg = loadConfig();
const db = openDb(cfg.dbPath);
const api = clientFromConfig(cfg);
const server = buildMcpServer({ db, api, cfg });
await server.connect(new StdioServerTransport());
```

Note: `clientFromConfig` throws if certs are missing in `development` — correct fail-fast behavior for the server entry; the error message tells the user what to do.

- [ ] **Step 5: Run tests, verify pass**

```bash
pnpm vitest run tests/mcp.test.ts
```

Expected: 4 passed. If the SDK's `registerTool`/`inputSchema` signature differs from the installed version, check `node_modules/@modelcontextprotocol/sdk/README.md` for the current high-level server API and adapt — the tool names, descriptions, zod shapes, and handlers are the contract; the registration call syntax is not.

- [ ] **Step 6: Typecheck, full suite, commit**

```bash
pnpm typecheck && pnpm test
git add src/mcp tests/mcp.test.ts
git commit -m "feat: mcp stdio server with five teller tools"
```

---

### Task 10: Build, README, cleanup, final verification

**Files:**
- Create: `README.md`
- Delete: `docs/legacy-reference/`
- Modify: none

**Interfaces:**
- Consumes: everything
- Produces: buildable, documented, verified project

- [ ] **Step 1: Verify production build and bins**

```bash
pnpm build
node dist/cli/index.js --help
```

Expected: commander help listing auth/sync/accounts/transactions/spending.

```bash
TELLER_CONFIG_DIR=/tmp/definitely-missing-teller node dist/mcp/index.js; echo "exit: $?"
```

Expected: ConfigError message with setup instructions, nonzero exit.

- [ ] **Step 2: Write `README.md`**

```markdown
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
```

- [ ] **Step 3: Remove legacy reference copies**

```bash
rm -rf docs/legacy-reference
```

- [ ] **Step 4: Full verification gate**

```bash
pnpm typecheck && pnpm test && pnpm build
git status   # expect only README.md + deletions staged-able; no stray files
```

Expected: typecheck clean, all test files pass, build clean.

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "docs: readme; remove legacy reference copies"
```

- [ ] **Step 6: Manual live smoke test (requires human — flag to user, do not automate)**

Real-world verification once the user has certs in place:

```bash
node dist/cli/index.js auth            # link a real bank (development env)
node dist/cli/index.js accounts
node dist/cli/index.js transactions --limit 5
node dist/cli/index.js spending --from 2026-06-01 --to 2026-07-16
```

This is the end-to-end proof; report results to the user rather than marking it done unilaterally.

---

## Self-Review Notes

- Spec coverage: schema (Task 3), config/file locations (Task 2), mTLS client + 429 retry (Task 4), pagination initial/incremental + error isolation (Task 5), query surface + staleness + spend definition (Task 6), auth flow + timeout + idempotent re-enrollment (Task 7 + auth command in Task 8), CLI commands + `--json` + exit codes 2/3 (Task 8), five MCP tools + agent-oriented descriptions + reauth messaging (Task 9), README + verification (Task 10). Out-of-scope items from spec correctly absent.
- Known judgment calls an implementer may hit: MCP SDK registration API drift (explicit fallback instructions in Task 9 Step 5); `server.address()` timing on port 0 (note in Task 7 Step 4).
