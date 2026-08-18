# Transaction Depth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store every field `/transactions/sync` returns, and correct a schema-policy error message that becomes false the day a bank is linked.

**Architecture:** No migration code. `src/core/db.ts` states that migrations do not exist because the tool has never shipped and deleting the database is free — a premise that still holds and that this plan is racing to stay ahead of. Every schema change is a plain edit to `SCHEMA` plus a `SCHEMA_VERSION` bump; a stale sandbox database is rejected loudly and deleted. Then `toTransactionRow`, `TransactionView`, and the query layer widen to carry the new fields.

Storage keeps everything; the MCP boundary does not. A 44-column row times a hundred transactions is a payload that is mostly nulls and competes with the model's reasoning budget, so `list_transactions` projects a lean subset by default and returns the full row on `verbose: true`. CLI `--json` always emits everything.

**Tech Stack:** TypeScript 7 (strict), better-sqlite3 12, plaid 45, vitest 4, commander 15.

**Spec:** `docs/superpowers/specs/2026-08-18-plaid-capability-expansion.md` (Feature 1)

## Global Constraints

- Node >= 22, ESM, `pnpm` only. `npm` and `yarn` forbidden.
- TypeScript strict. `pnpm typecheck` runs `tsc --noEmit` over `src` and `tests`.
- Money is `INTEGER` cents in SQLite, decimal dollars at every output boundary. Conversion only in `src/core/money.ts` (ingest) and `src/core/views.ts` (egress).
- Plaid's amount sign is preserved in storage: **positive means money left the account.** Aggregates report positive magnitudes.
- Tests never reach the network. The Plaid SDK is injected via the `PlaidSdk` interface and stubbed.
- Reads never hit the Plaid API.
- Every CLI command supports `--json` except `init`.
- CLI and MCP share the same view functions; they must not drift.
- **No migration code.** Schema changes are `SCHEMA` edits plus a `SCHEMA_VERSION` bump. Delete the sandbox database when the version changes.
- **This plan must land before any production bank is linked.** After that, deleting the database means re-linking every bank and burning Item slots against the cap of 10, and the no-migrations policy has to be replaced.

## Why there is no migration runner here

An earlier draft of this plan built an additive migration runner first. That was
wrong. `src/core/db.ts` already answers the question:

> "There are no migrations: the tool has never shipped, so any mismatch means a
> database from a pre-release build, and the honest fix is to delete it and
> re-sync from Plaid rather than carry migration code forever."

No production Item exists yet, so that premise is intact and deletion is free.
A migration runner today is speculative infrastructure for a database with no
users. Task 1 instead records *when* the premise expires, so the next reader
knows the policy has a shelf life rather than discovering it the hard way.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/core/db.ts` | Schema, row types, all SQL | Modify — v3 `SCHEMA`, widened `TransactionRow` and upsert, corrected policy text |
| `tests/db.test.ts` | Schema behaviour | Modify |
| `src/core/sync.ts` | Plaid `Transaction` → `TransactionRow` | Modify — `toTransactionRow` maps new fields |
| `tests/sync.test.ts` | Mapping tests | Modify |
| `src/core/views.ts` | Output boundary, cents → dollars | Modify — full `TransactionView` plus a lean projection and a `verbose` envelope |
| `tests/views.test.ts` | View tests | Modify |
| `src/core/queries.ts` | Filters and aggregation SQL | Modify — merchant grouping by entity id, `payment_channel` groupBy, search over `original_description` |
| `tests/queries.test.ts` | Query tests | Modify |
| `tests/helpers.ts` | Shared seed database and fixtures | Modify — seed rows gain new fields, `fullTransactionRow` moves here |
| `src/cli/index.ts` | Command surface | Modify — pass `verbose: true` so `--json` keeps emitting every field |
| `src/mcp/server.ts` | MCP tool definitions | Modify — `verbose` argument, new groupBy value, field documentation |
| `README.md` | User docs | Modify |

---

### Task 1: Schema v3 — widen transactions, correct the policy text

**Files:**
- Modify: `src/core/db.ts` — `SCHEMA`, `SCHEMA_VERSION`, `applySchema`, `TransactionRow`, `upsertTransactions`
- Test: `tests/db.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `TransactionRow` with 34 added members, and with `type: string` **removed**. Tasks 2–5 depend on this exact shape:
  ```ts
  authorized_date: string | null;
  authorized_datetime: string | null;
  datetime: string | null;
  original_description: string | null;
  iso_currency_code: string | null;
  unofficial_currency_code: string | null;
  category_confidence: string | null;
  category_icon_url: string | null;
  merchant_entity_id: string | null;
  merchant_category_code: string | null;
  website: string | null;
  logo_url: string | null;
  counterparty_type: string | null;
  counterparties_json: string | null;
  payment_channel: string;
  transaction_code: string | null;
  check_number: string | null;
  account_owner: string | null;
  location_address: string | null;
  location_city: string | null;
  location_region: string | null;
  location_postal_code: string | null;
  location_country: string | null;
  location_lat: number | null;
  location_lon: number | null;
  location_store_number: string | null;
  payment_meta_reference_number: string | null;
  payment_meta_ppd_id: string | null;
  payment_meta_payee: string | null;
  payment_meta_by_order_of: string | null;
  payment_meta_payer: string | null;
  payment_meta_payment_method: string | null;
  payment_meta_payment_processor: string | null;
  payment_meta_reason: string | null;
  ```
  Every member is nullable except `payment_channel`, which Plaid always sends. `location_lat` and `location_lon` are `number | null` — the only non-string additions.

- [ ] **Step 1: Write the failing tests**

Add to `tests/db.test.ts`:

```ts
describe('schema v3', () => {
  // Every field non-null on purpose. A column missing from the INSERT or the
  // ON CONFLICT list shows up as a mismatch here; a fixture full of nulls
  // would hide exactly that.
  const fullRow = (over: Partial<TransactionRow> = {}): TransactionRow => ({
    id: 't1', account_id: 'acc_1', date: '2026-08-01', description: 'COFFEE',
    amount_cents: 450, category_primary: 'FOOD_AND_DRINK',
    category_detailed: 'FOOD_AND_DRINK_COFFEE', counterparty: 'Blue Bottle',
    status: 'posted', pending_transaction_id: 'pend_1',
    authorized_date: '2026-07-31', authorized_datetime: '2026-07-31T18:04:00Z',
    datetime: '2026-08-01T02:11:00Z',
    original_description: 'SQ *BLUE BOTTLE 4411',
    iso_currency_code: 'USD', unofficial_currency_code: 'BTC',
    category_confidence: 'VERY_HIGH',
    category_icon_url: 'https://plaid-category-icons.plaid.com/FOOD_AND_DRINK.png',
    merchant_entity_id: 'ent_bb', merchant_category_code: '5814',
    website: 'bluebottlecoffee.com',
    logo_url: 'https://plaid-merchant-logos.plaid.com/blue_bottle.png',
    counterparty_type: 'merchant',
    counterparties_json: '[{"name":"Blue Bottle","type":"merchant"}]',
    payment_channel: 'in store', transaction_code: 'purchase',
    check_number: '1234', account_owner: 'AARON PAVLICK',
    location_address: '300 Webster St', location_city: 'Oakland',
    location_region: 'CA', location_postal_code: '94607',
    location_country: 'US', location_lat: 37.8, location_lon: -122.27,
    location_store_number: '4411',
    payment_meta_reference_number: 'REF1', payment_meta_ppd_id: 'PPD1',
    payment_meta_payee: 'Payee', payment_meta_by_order_of: 'Order',
    payment_meta_payer: 'Payer', payment_meta_payment_method: 'ACH',
    payment_meta_payment_processor: 'Stripe', payment_meta_reason: 'Reason',
    ...over,
  });

  it('round-trips every column a TransactionRow declares', () => {
    const db = seedDb();
    const row = fullRow({ id: 't_full' });

    upsertTransactions(db, [row]);

    const read = db.prepare('SELECT * FROM transactions WHERE id = ?').get('t_full');
    // Equality against the whole row, not field-by-field: a column present in
    // the type but missing from the INSERT would otherwise pass unnoticed.
    expect(read).toEqual(row);
  });

  it('updates every column on conflict', () => {
    const db = seedDb();
    upsertTransactions(db, [fullRow({ id: 't_up' })]);

    // Every mutable column changes value. A column left out of the ON CONFLICT
    // list keeps its old value and fails this comparison.
    const changed: TransactionRow = Object.fromEntries(
      Object.entries(fullRow({ id: 't_up' })).map(([k, v]) => {
        if (k === 'id' || k === 'account_id') return [k, v];
        if (typeof v === 'number') return [k, v + 1];
        return [k, `${String(v)}-changed`];
      }),
    ) as TransactionRow;
    upsertTransactions(db, [changed]);

    expect(db.prepare('SELECT * FROM transactions WHERE id = ?').get('t_up')).toEqual(changed);
  });

  it('has no `type` column — payment_channel replaced it', () => {
    const db = seedDb();

    const columns = (db.pragma('table_info(transactions)') as Array<{ name: string }>)
      .map(c => c.name);

    expect(columns).toContain('payment_channel');
    expect(columns).not.toContain('type');
  });

  it('rejects a database written by an older build, naming the real cost', () => {
    const dbPath = tmpDbPath('stale');
    const raw = new Database(dbPath);
    raw.exec('CREATE TABLE items (id TEXT PRIMARY KEY)');
    raw.pragma('user_version = 2');
    raw.close();

    // The old message claimed "No data is lost by deleting it", which is false
    // once an access token is in there and contradicts the README.
    expect(() => openDb(dbPath, 'sandbox')).toThrow(/re-link/i);
    expect(() => openDb(dbPath, 'sandbox')).not.toThrow(/No data is lost/i);
  });
});
```

`tmpDbPath` may not exist in this suite yet. If not, add it near the top of the file:

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function tmpDbPath(name: string): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-test-')), `${name}.db`);
}
```

Add `import Database from 'better-sqlite3';` if it is not already imported.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/db.test.ts -t "schema v3"`
Expected: FAIL — `no such column: authorized_date`, and a type error on the `TransactionRow` literal.

- [ ] **Step 3: Update the `SCHEMA` constant**

In `src/core/db.ts`, replace the `transactions` `CREATE TABLE` and the index list inside `SCHEMA` with:

```sql
CREATE TABLE IF NOT EXISTS transactions (
  id                             TEXT PRIMARY KEY,
  account_id                     TEXT NOT NULL REFERENCES accounts(id),
  date                           TEXT NOT NULL,
  description                    TEXT NOT NULL,
  amount_cents                   INTEGER NOT NULL,
  category_primary               TEXT,
  category_detailed              TEXT,
  counterparty                   TEXT,
  status                         TEXT NOT NULL,
  pending_transaction_id         TEXT,
  authorized_date                TEXT,
  authorized_datetime            TEXT,
  datetime                       TEXT,
  original_description           TEXT,
  iso_currency_code              TEXT,
  unofficial_currency_code       TEXT,
  category_confidence            TEXT,
  category_icon_url              TEXT,
  merchant_entity_id             TEXT,
  merchant_category_code         TEXT,
  website                        TEXT,
  logo_url                       TEXT,
  counterparty_type              TEXT,
  counterparties_json            TEXT,
  payment_channel                TEXT NOT NULL,
  transaction_code               TEXT,
  check_number                   TEXT,
  account_owner                  TEXT,
  location_address               TEXT,
  location_city                  TEXT,
  location_region                TEXT,
  location_postal_code           TEXT,
  location_country               TEXT,
  location_lat                   REAL,
  location_lon                   REAL,
  location_store_number          TEXT,
  payment_meta_reference_number  TEXT,
  payment_meta_ppd_id            TEXT,
  payment_meta_payee             TEXT,
  payment_meta_by_order_of       TEXT,
  payment_meta_payer             TEXT,
  payment_meta_payment_method    TEXT,
  payment_meta_payment_processor TEXT,
  payment_meta_reason            TEXT
);
CREATE INDEX IF NOT EXISTS idx_txn_account_date ON transactions(account_id, date);
CREATE INDEX IF NOT EXISTS idx_txn_date ON transactions(date);
CREATE INDEX IF NOT EXISTS idx_txn_category ON transactions(category_primary);
CREATE INDEX IF NOT EXISTS idx_txn_merchant_entity ON transactions(merchant_entity_id);
CREATE INDEX IF NOT EXISTS idx_txn_authorized_date ON transactions(authorized_date);
CREATE INDEX IF NOT EXISTS idx_acct_item ON accounts(item_id);
```

Notes on three choices:

- `payment_channel` is `NOT NULL` because Plaid always sends it, and without
  `ALTER TABLE` in the picture the column can simply be declared correctly.
- `location_lat` / `location_lon` are `REAL`, the only non-`TEXT` additions.
  They are coordinates, not money — the integer-cents rule does not apply.
- `counterparties_json` holds the array verbatim. Every other nested object
  Plaid sends here (`location`, `payment_meta`) is a flat fixed shape and is
  flattened into columns; `counterparties` is variable-length and carries its
  own nested `account_numbers`, so flattening it would mean either an arbitrary
  cap or a child table. JSON keeps it lossless, and the primary entry's `type`
  is denormalised into `counterparty_type` for querying.

The old `type` column is gone — deleted from the `CREATE TABLE`, not renamed.
It held `payment_channel` under a misleading name.

Deliberately still absent: `category`, `category_id`, and `transaction_type`.
Plaid marks all three deprecated and `personal_finance_category` supersedes
them, so a column for each would go permanently null the day Plaid drops them.

- [ ] **Step 4: Bump the version and correct the policy text**

Replace the `SCHEMA_VERSION` declaration and its comment with:

```ts
/**
 * Bumped whenever the schema changes. Stored in `PRAGMA user_version` so a
 * database written by an older build is rejected loudly instead of failing later
 * with a confusing missing-column error — `CREATE TABLE IF NOT EXISTS` silently
 * no-ops against an existing table with different columns.
 */
const SCHEMA_VERSION = 3;
```

Replace the doc comment on `applySchema` with:

```ts
/**
 * Creates the schema on a fresh database, or verifies an existing one matches
 * this build. There are no migrations: the tool has never shipped, so any
 * mismatch means a database from a pre-release build, and the honest fix is to
 * delete it and re-sync from Plaid rather than carry migration code forever.
 *
 * THIS POLICY HAS AN EXPIRY. It holds only while no bank is linked. The database
 * stores the access tokens, and those are the one thing here that cannot be
 * re-downloaded — so once a real Item exists, "just delete it" means re-linking
 * every bank and consuming Item slots against the Trial plan's cap of 10.
 *
 * Make schema changes BEFORE linking. Once Items exist, replace this with
 * additive migrations rather than asking a user to throw their enrollments away.
 */
```

- [ ] **Step 5: Fix the false error message**

In the `version === 0` branch of `applySchema`, replace the thrown error with:

```ts
      throw new Error(
        `${dbPath} was created by an older build with an incompatible schema, and there ` +
          `are no migrations. Delete the file (and its -wal/-shm siblings), then run ` +
          `\`ledger auth\`. Transactions are all re-downloadable from Plaid; the access ` +
          `tokens are not, so every bank has to be linked again — which consumes Item ` +
          `slots against the Trial plan's cap of 10.`,
      );
```

The previous text asserted *"No data is lost by deleting it — every row is
re-downloadable from Plaid."* That is false as soon as an access token exists,
and the README already contradicts it.

- [ ] **Step 6: Update `TransactionRow` and `upsertTransactions`**

In the `TransactionRow` interface, delete the `type: string;` member and its comment, then add:

```ts
  /** Purchase date when the institution reports it. `date` is the POST date. */
  authorized_date: string | null;
  /** ISO 8601. Rare — most US institutions report dates only. */
  authorized_datetime: string | null;
  /** ISO 8601 post timestamp. Rare, same reason. */
  datetime: string | null;
  /** Raw bank memo before Plaid's cleanup. Searched alongside `description`. */
  original_description: string | null;
  /** Plaid populates exactly one of these two. Both stored, neither coalesced. */
  iso_currency_code: string | null;
  /** Set instead of `iso_currency_code` for crypto and unofficial currencies. */
  unofficial_currency_code: string | null;
  /** VERY_HIGH | HIGH | MEDIUM | LOW | UNKNOWN. Null when Plaid omits it. */
  category_confidence: string | null;
  category_icon_url: string | null;
  /** Stable merchant id across name variants. Group on this, display the name. */
  merchant_entity_id: string | null;
  /** ISO 18245 MCC. Coarser than Plaid's category but institution-reported. */
  merchant_category_code: string | null;
  website: string | null;
  logo_url: string | null;
  /**
   * Type of the primary counterparty: merchant, payment_app,
   * financial_institution, marketplace, payment_terminal, income_source.
   * `payment_app` is the useful one — it marks a Venmo or Cash App hop where
   * `counterparty` is the app, not who was actually paid.
   */
  counterparty_type: string | null;
  /**
   * The whole `counterparties` array as JSON, verbatim.
   *
   * Stored rather than flattened because it is variable-length and carries a
   * nested `account_numbers` object; flattening would need an arbitrary cap or
   * a child table. Query the denormalised `counterparty` and `counterparty_type`
   * columns; reach into this only when the full chain matters.
   */
  counterparties_json: string | null;
  /** online | in store | other. Held by the old `type` column before v3. */
  payment_channel: string;
  /** The real transaction type: ACH, bill payment, transfer, and similar. */
  transaction_code: string | null;
  check_number: string | null;
  /** Which owner of a joint account transacted, when the institution says. */
  account_owner: string | null;
  location_address: string | null;
  location_city: string | null;
  location_region: string | null;
  location_postal_code: string | null;
  location_country: string | null;
  /** Coordinates, not money — REAL is correct here, cents are not involved. */
  location_lat: number | null;
  location_lon: number | null;
  location_store_number: string | null;
  payment_meta_reference_number: string | null;
  payment_meta_ppd_id: string | null;
  payment_meta_payee: string | null;
  payment_meta_by_order_of: string | null;
  payment_meta_payer: string | null;
  payment_meta_payment_method: string | null;
  payment_meta_payment_processor: string | null;
  payment_meta_reason: string | null;
```

Then replace the hand-written `INSERT` in `upsertTransactions` with SQL derived from a column list. At 44 columns a literal statement means 44 names, 44 placeholders, and 42 `ON CONFLICT` assignments kept in sync by hand — a column silently dropped from any one of the three is the exact bug that survives review.

Add above `upsertTransactions`:

```ts
/**
 * Every `transactions` column, in CREATE TABLE order. The single source for the
 * upsert SQL below, so a new column cannot be added to the table and forgotten
 * in the INSERT, the VALUES, or the ON CONFLICT list.
 */
const TXN_COLUMNS = [
  'id', 'account_id', 'date', 'description', 'amount_cents',
  'category_primary', 'category_detailed', 'counterparty', 'status',
  'pending_transaction_id', 'authorized_date', 'authorized_datetime', 'datetime',
  'original_description', 'iso_currency_code', 'unofficial_currency_code',
  'category_confidence', 'category_icon_url', 'merchant_entity_id',
  'merchant_category_code', 'website', 'logo_url', 'counterparty_type',
  'counterparties_json', 'payment_channel', 'transaction_code', 'check_number',
  'account_owner', 'location_address', 'location_city', 'location_region',
  'location_postal_code', 'location_country', 'location_lat', 'location_lon',
  'location_store_number', 'payment_meta_reference_number', 'payment_meta_ppd_id',
  'payment_meta_payee', 'payment_meta_by_order_of', 'payment_meta_payer',
  'payment_meta_payment_method', 'payment_meta_payment_processor',
  'payment_meta_reason',
] as const;

type TxnColumn = (typeof TXN_COLUMNS)[number];

/**
 * Compile-time guard that TXN_COLUMNS and TransactionRow describe the same set
 * of fields. Resolves to `true` when they agree and to a descriptive object type
 * when they do not, so the assignment below fails with the offending names in
 * the error text rather than a bare type mismatch.
 */
type ColumnsMatchRow = [Exclude<TxnColumn, keyof TransactionRow>] extends [never]
  ? [Exclude<keyof TransactionRow, TxnColumn>] extends [never]
    ? true
    : {
        error: 'TransactionRow declares fields absent from TXN_COLUMNS';
        missing: Exclude<keyof TransactionRow, TxnColumn>;
      }
  : {
      error: 'TXN_COLUMNS lists names absent from TransactionRow';
      extra: Exclude<TxnColumn, keyof TransactionRow>;
    };

/** Exported so `noUnusedLocals` keeps the guard above alive. */
export const COLUMNS_MATCH_ROW: ColumnsMatchRow = true;

/** Identity columns are never rewritten; a re-sent transaction keeps its keys. */
const TXN_MUTABLE_COLUMNS = TXN_COLUMNS.filter(c => c !== 'id' && c !== 'account_id');

const UPSERT_TRANSACTION_SQL = `INSERT INTO transactions (${TXN_COLUMNS.join(', ')})
   VALUES (${TXN_COLUMNS.map(c => `@${c}`).join(', ')})
   ON CONFLICT(id) DO UPDATE SET
     ${TXN_MUTABLE_COLUMNS.map(c => `${c} = excluded.${c}`).join(',\n     ')}`;
```

Then in `upsertTransactions`, replace the `db.prepare(...)` call with:

```ts
  const stmt = db.prepare(UPSERT_TRANSACTION_SQL);
```

The column names are compile-time constants from a `readonly` tuple, never
caller input, so the interpolation carries no injection surface. Values still
bind through named parameters exactly as before.

- [ ] **Step 7: Delete your sandbox database**

The version bump makes any existing local database unopenable — deliberately.

```bash
rm -f ~/.local/share/ledger/ledger.db*
```

If `LEDGER_DATA_DIR` is set, delete the database there instead. This is free
right now and will not be after the first production link.

- [ ] **Step 8: Run the tests**

Run: `pnpm vitest run tests/db.test.ts -t "schema v3"`
Expected: PASS, all four cases.

- [ ] **Step 9: Run the whole suite**

Run: `pnpm test`
Expected: FAIL in `sync`, `views`, `queries`, and `helpers` — they still set `type`. `pnpm typecheck` reports the same as type errors. Tasks 2–5 fix them in order. Do not patch them here.

- [ ] **Step 10: Commit**

```bash
git add src/core/db.ts tests/db.test.ts
git commit -m "feat(db): schema v3 — ten Plaid fields, drop the misnamed type column

Also corrects the version-0 error, which claimed no data is lost by
deleting the database. The access tokens are in there and are the one
thing Plaid will not resend. Records when the no-migrations policy expires."
```

---

### Task 2: Map the new fields at ingest

**Files:**
- Modify: `src/core/sync.ts:34-49` (`toTransactionRow`)
- Test: `tests/sync.test.ts`

**Interfaces:**
- Consumes: `TransactionRow` from Task 1.
- Produces: `toTransactionRow(t: Transaction): TransactionRow` — unchanged signature, wider output.

- [ ] **Step 1: Write the failing test**

Add to `tests/sync.test.ts`:

```ts
describe('toTransactionRow field mapping', () => {
  it('carries the enrichment fields Plaid sends', () => {
    const row = toTransactionRow(
      txn('t_rich', {
        authorized_date: '2026-07-30',
        original_description: 'SQ *BLUE BOTTLE 4411',
        merchant_entity_id: 'ent_bluebottle',
        transaction_code: 'purchase' as Transaction['transaction_code'],
        personal_finance_category: {
          primary: 'FOOD_AND_DRINK',
          detailed: 'FOOD_AND_DRINK_COFFEE',
          confidence_level: 'VERY_HIGH',
        },
        location: {
          address: null, city: 'Oakland', region: 'CA', postal_code: null,
          country: 'US', lat: null, lon: null, store_number: null,
        } as Transaction['location'],
      }),
    );

    expect(row.authorized_date).toBe('2026-07-30');
    expect(row.original_description).toBe('SQ *BLUE BOTTLE 4411');
    expect(row.merchant_entity_id).toBe('ent_bluebottle');
    expect(row.transaction_code).toBe('purchase');
    expect(row.category_confidence).toBe('VERY_HIGH');
    expect(row.location_city).toBe('Oakland');
    expect(row.location_region).toBe('CA');
    expect(row.payment_channel).toBe('in store');
    expect(row.iso_currency_code).toBe('USD');
  });

  it('nulls every optional field when Plaid omits it', () => {
    const row = toTransactionRow(
      txn('t_bare', {
        merchant_name: null,
        personal_finance_category: null,
        iso_currency_code: null,
        unofficial_currency_code: null,
      }),
    );

    expect(row.authorized_date).toBeNull();
    expect(row.original_description).toBeNull();
    expect(row.merchant_entity_id).toBeNull();
    expect(row.transaction_code).toBeNull();
    expect(row.category_confidence).toBeNull();
    expect(row.counterparty).toBeNull();
    expect(row.counterparty_type).toBeNull();
    expect(row.iso_currency_code).toBeNull();
  });

  it('falls back to the primary counterparty when merchant_name is absent, and records its type', () => {
    const row = toTransactionRow(
      txn('t_venmo', {
        merchant_name: null,
        counterparties: [
          {
            name: 'Venmo',
            type: 'payment_app' as never,
            entity_id: 'ent_venmo',
            website: null,
            logo_url: null,
            confidence_level: 'HIGH',
          },
        ] as Transaction['counterparties'],
      }),
    );

    expect(row.counterparty).toBe('Venmo');
    expect(row.counterparty_type).toBe('payment_app');
  });

  it('keeps the two currency codes separate rather than coalescing them', () => {
    const row = toTransactionRow(
      txn('t_crypto', { iso_currency_code: null, unofficial_currency_code: 'BTC' }),
    );

    expect(row.iso_currency_code).toBeNull();
    expect(row.unofficial_currency_code).toBe('BTC');
  });

  it('flattens location and payment_meta into their own columns', () => {
    const row = toTransactionRow(
      txn('t_ach', {
        location: {
          address: '300 Webster St', city: 'Oakland', region: 'CA',
          postal_code: '94607', country: 'US', lat: 37.8, lon: -122.27,
          store_number: '4411',
        } as Transaction['location'],
        payment_meta: {
          reference_number: 'REF1', ppd_id: 'PPD1', payee: 'Landlord',
          by_order_of: null, payer: null, payment_method: 'ACH',
          payment_processor: null, reason: 'RENT',
        } as Transaction['payment_meta'],
        check_number: '1234',
        account_owner: 'AARON PAVLICK',
      }),
    );

    expect(row.location_address).toBe('300 Webster St');
    expect(row.location_postal_code).toBe('94607');
    expect(row.location_lat).toBe(37.8);
    expect(row.location_lon).toBe(-122.27);
    expect(row.location_store_number).toBe('4411');
    expect(row.payment_meta_reference_number).toBe('REF1');
    expect(row.payment_meta_payee).toBe('Landlord');
    expect(row.payment_meta_payment_method).toBe('ACH');
    expect(row.payment_meta_reason).toBe('RENT');
    expect(row.payment_meta_by_order_of).toBeNull();
    expect(row.check_number).toBe('1234');
    expect(row.account_owner).toBe('AARON PAVLICK');
  });

  it('stores the whole counterparties array as JSON, and NULL when absent', () => {
    const withArray = toTransactionRow(
      txn('t_cp', {
        counterparties: [
          { name: 'Venmo', type: 'payment_app' as never, entity_id: 'ent_v',
            website: null, logo_url: null, confidence_level: 'HIGH' },
          { name: 'Corner Store', type: 'merchant' as never, entity_id: 'ent_c',
            website: null, logo_url: null, confidence_level: 'MEDIUM' },
        ] as Transaction['counterparties'],
      }),
    );
    const without = toTransactionRow(txn('t_nocp', { counterparties: undefined }));

    // The full chain survives even though only the primary is denormalised.
    expect(JSON.parse(withArray.counterparties_json ?? '[]')).toHaveLength(2);
    expect(withArray.counterparty_type).toBe('payment_app');
    // NULL, not "[]" — "Plaid sent nothing" and "Plaid sent an empty list" differ.
    expect(without.counterparties_json).toBeNull();
  });

  it('survives a payload missing location and payment_meta entirely', () => {
    const row = toTransactionRow(
      txn('t_sparse', {
        location: undefined as never,
        payment_meta: undefined as never,
      }),
    );

    expect(row.location_city).toBeNull();
    expect(row.payment_meta_payee).toBeNull();
  });
});
```

The existing `txn()` helper in this file already casts to `Transaction`, so the extra fields need no change to it.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/sync.test.ts -t "field mapping"`
Expected: FAIL — the properties do not exist on the returned object.

- [ ] **Step 3: Rewrite `toTransactionRow`**

Replace `src/core/sync.ts:34-49` with:

```ts
export function toTransactionRow(t: Transaction): TransactionRow {
  // Plaid orders counterparties by descending confidence, so [0] is the primary.
  // When merchant_name is set it is normally the same entity; when it is not,
  // this is the only name available.
  const primary = t.counterparties?.[0];
  return {
    id: t.transaction_id,
    account_id: t.account_id,
    date: t.date,
    authorized_date: t.authorized_date ?? null,
    authorized_datetime: t.authorized_datetime ?? null,
    datetime: t.datetime ?? null,
    description: t.name,
    original_description: t.original_description ?? null,
    // The one place decimal dollars become integer cents. The sign is kept
    // exactly as Plaid sends it: POSITIVE means money left the account.
    amount_cents: toCents(t.amount),
    // Both stored as sent. Plaid populates exactly one, and which one it picks
    // is information — coalescing them would erase that a value was unofficial.
    iso_currency_code: t.iso_currency_code ?? null,
    unofficial_currency_code: t.unofficial_currency_code ?? null,
    category_primary: t.personal_finance_category?.primary ?? null,
    category_detailed: t.personal_finance_category?.detailed ?? null,
    category_confidence: t.personal_finance_category?.confidence_level ?? null,
    category_icon_url: t.personal_finance_category_icon_url ?? null,
    counterparty: t.merchant_name ?? primary?.name ?? null,
    counterparty_type: primary?.type ?? null,
    // Only when Plaid sent one, so an absent array stays NULL rather than
    // becoming the string "[]" — those mean different things.
    counterparties_json:
      t.counterparties === undefined ? null : JSON.stringify(t.counterparties),
    merchant_entity_id: t.merchant_entity_id ?? null,
    merchant_category_code: t.merchant_category_code ?? null,
    website: t.website ?? null,
    logo_url: t.logo_url ?? null,
    payment_channel: t.payment_channel,
    transaction_code: t.transaction_code ?? null,
    check_number: t.check_number ?? null,
    account_owner: t.account_owner ?? null,
    location_address: t.location?.address ?? null,
    location_city: t.location?.city ?? null,
    location_region: t.location?.region ?? null,
    location_postal_code: t.location?.postal_code ?? null,
    location_country: t.location?.country ?? null,
    location_lat: t.location?.lat ?? null,
    location_lon: t.location?.lon ?? null,
    location_store_number: t.location?.store_number ?? null,
    payment_meta_reference_number: t.payment_meta?.reference_number ?? null,
    payment_meta_ppd_id: t.payment_meta?.ppd_id ?? null,
    payment_meta_payee: t.payment_meta?.payee ?? null,
    payment_meta_by_order_of: t.payment_meta?.by_order_of ?? null,
    payment_meta_payer: t.payment_meta?.payer ?? null,
    payment_meta_payment_method: t.payment_meta?.payment_method ?? null,
    payment_meta_payment_processor: t.payment_meta?.payment_processor ?? null,
    payment_meta_reason: t.payment_meta?.reason ?? null,
    status: t.pending ? 'pending' : 'posted',
    pending_transaction_id: t.pending_transaction_id ?? null,
  };
}
```

`location` and `payment_meta` are non-optional in Plaid's type but are accessed
with `?.` anyway: these objects come off the wire, and a stub or a future SDK
revision that omits one should produce nulls rather than a `TypeError` in the
middle of a sync page.

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run tests/sync.test.ts`
Expected: PASS. Any pre-existing assertion on `row.type` in this file must become `row.payment_channel` — that is the rename, not a regression.

- [ ] **Step 5: Commit**

```bash
git add src/core/sync.ts tests/sync.test.ts
git commit -m "feat(sync): map authorized_date, confidence, merchant entity, channel, location"
```

---

### Task 3: Widen the output boundary, and add a lean projection for agents

**Files:**
- Modify: `src/core/views.ts:36, 48-63` (`TransactionView`, `transactionView`), plus new `LeanTransactionView`, `leanTransactionView`, `transactionsResultView` signature
- Test: `tests/views.test.ts`

**Interfaces:**
- Consumes: `TransactionRow` from Task 1.
- Produces:
  ```ts
  export type TransactionView = Omit<TransactionRow, 'amount_cents'> & { amount: number };
  export function transactionView(row: TransactionRow): TransactionView;

  export type LeanTransactionView = Pick<TransactionView,
    | 'id' | 'account_id' | 'date' | 'authorized_date' | 'description' | 'amount'
    | 'category_primary' | 'category_detailed' | 'category_confidence'
    | 'counterparty' | 'counterparty_type' | 'merchant_entity_id'
    | 'payment_channel' | 'status' | 'iso_currency_code'>;
  export function leanTransactionView(row: TransactionRow): LeanTransactionView;

  export function transactionsResultView(
    result: { transactions: TransactionRow[]; total: number; meta: QueryMeta },
    opts?: { verbose?: boolean | undefined },
  ): { transactions: Array<TransactionView | LeanTransactionView>; total: number; meta: QueryMeta };
  ```
  `transactionsResultView` keeps its existing one-argument call signature, so the CLI compiles unchanged — but the CLI will opt into `verbose` in Task 5.

`views.ts` lists every field explicitly rather than spreading, so the full view exists precisely because Task 1 broke compilation here. That is the design working.

**Why a second view.** Storage keeps everything; a tool result should not. Forty-four fields times a hundred rows is a payload that is mostly nulls, and it spends the model's context on `payment_meta_by_order_of: null` instead of on reasoning. The lean set is the fifteen fields an agent actually reasons with. Nothing is hidden — `verbose: true` returns the full row, and the CLI never truncates at all.

- [ ] **Step 1: Write the failing tests**

Add to `tests/views.test.ts`. Reuse the `fullRow` fixture from Task 1's `tests/db.test.ts` by exporting it from `tests/helpers.ts` instead of duplicating it — a second 44-field literal would drift.

Move `fullRow` into `tests/helpers.ts` as:

```ts
/** A TransactionRow with every field non-null. Shared by db and views tests. */
export function fullTransactionRow(over: Partial<TransactionRow> = {}): TransactionRow {
  return { /* the same literal written in Task 1 Step 1 */ ...over };
}
```

and have `tests/db.test.ts` import it. Then add to `tests/views.test.ts`:

```ts
it('passes every stored field through to the full view, converting only the amount', () => {
  const row = fullTransactionRow();

  const view = transactionView(row);

  // Compare against the row itself rather than listing 44 assertions: a field
  // dropped from transactionView shows up here, a hand-written list would miss it.
  const { amount_cents, ...rest } = row;
  expect(view).toEqual({ ...rest, amount: 4.5 });
  expect('amount_cents' in view).toBe(false);
});

it('lean view carries the fields an agent reasons with and nothing else', () => {
  const view = leanTransactionView(fullTransactionRow());

  expect(Object.keys(view).sort()).toEqual(
    [
      'account_id', 'amount', 'authorized_date', 'category_confidence',
      'category_detailed', 'category_primary', 'counterparty', 'counterparty_type',
      'date', 'description', 'id', 'iso_currency_code', 'merchant_entity_id',
      'payment_channel', 'status',
    ].sort(),
  );
  expect(view.amount).toBe(4.5);
});

it('lean view drops the bulky fields', () => {
  const view = leanTransactionView(fullTransactionRow()) as Record<string, unknown>;

  for (const dropped of [
    'counterparties_json', 'logo_url', 'category_icon_url', 'location_address',
    'payment_meta_reference_number', 'original_description',
  ]) {
    expect(view).not.toHaveProperty(dropped);
  }
});

it('transactionsResultView is lean by default and full under verbose', () => {
  const result = { transactions: [fullTransactionRow()], total: 1, meta: { last_synced_at: NOW, stale: false } };

  const lean = transactionsResultView(result);
  const verbose = transactionsResultView(result, { verbose: true });

  expect(lean.transactions[0]).not.toHaveProperty('counterparties_json');
  expect(verbose.transactions[0]).toHaveProperty('counterparties_json');
  expect(lean.total).toBe(1);
  expect(verbose.total).toBe(1);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/views.test.ts`
Expected: FAIL — `leanTransactionView` is not exported, and the full view is missing the new properties.

- [ ] **Step 3: Rewrite `transactionView`**

Replace `src/core/views.ts:48-63` with:

```ts
export function transactionView(row: TransactionRow): TransactionView {
  const { amount_cents, ...rest } = row;
  return {
    ...rest,
    // The only transformation at this boundary. Sign is untouched: POSITIVE is
    // still money leaving the account.
    amount: centsToDollars(amount_cents),
  };
}
```

This is the one place the explicit-field-listing convention is dropped, and
deliberately. At 44 fields the list stopped catching mistakes and started
causing them: the `Omit`-derived type already makes a dropped field a
compile error, and destructuring `amount_cents` out by name means the
conversion cannot be skipped. Listing 43 identity assignments underneath would
add no safety and one more place to forget a column.

- [ ] **Step 4: Add the lean view**

Append to `src/core/views.ts`:

```ts
/**
 * The subset of a transaction an agent reasons with.
 *
 * Storage keeps every field Plaid sends, because re-fetching is only free until
 * a bank is linked. A tool result is a different problem: forty-four fields
 * times a hundred rows is mostly nulls, and every null spends context the model
 * needs for the actual question. Nothing here is hidden — callers that want the
 * whole row ask for it.
 */
export type LeanTransactionView = Pick<
  TransactionView,
  | 'id'
  | 'account_id'
  | 'date'
  | 'authorized_date'
  | 'description'
  | 'amount'
  | 'category_primary'
  | 'category_detailed'
  | 'category_confidence'
  | 'counterparty'
  | 'counterparty_type'
  | 'merchant_entity_id'
  | 'payment_channel'
  | 'status'
  | 'iso_currency_code'
>;

export function leanTransactionView(row: TransactionRow): LeanTransactionView {
  const full = transactionView(row);
  return {
    id: full.id,
    account_id: full.account_id,
    date: full.date,
    authorized_date: full.authorized_date,
    description: full.description,
    amount: full.amount,
    category_primary: full.category_primary,
    category_detailed: full.category_detailed,
    category_confidence: full.category_confidence,
    counterparty: full.counterparty,
    counterparty_type: full.counterparty_type,
    merchant_entity_id: full.merchant_entity_id,
    payment_channel: full.payment_channel,
    status: full.status,
    iso_currency_code: full.iso_currency_code,
  };
}
```

Listed explicitly here, unlike `transactionView`: this projection is a
deliberate editorial choice about what an agent sees, so adding a field to
`TransactionRow` must **not** silently widen it.

- [ ] **Step 5: Make the result envelope selectable**

Replace `transactionsResultView` with:

```ts
export function transactionsResultView(
  result: { transactions: TransactionRow[]; total: number; meta: QueryMeta },
  opts: { verbose?: boolean | undefined } = {},
): {
  transactions: Array<TransactionView | LeanTransactionView>;
  total: number;
  meta: QueryMeta;
} {
  // Lean by default: the MCP server is the high-volume caller and the one with
  // a context budget. The CLI passes verbose and gets everything.
  const project = opts.verbose === true ? transactionView : leanTransactionView;
  return {
    transactions: result.transactions.map(project),
    total: result.total,
    meta: result.meta,
  };
}
```

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run tests/views.test.ts && pnpm typecheck`
Expected: PASS for views. `typecheck` still fails in `queries.ts` and `helpers.ts` — Tasks 4 and 5.

- [ ] **Step 7: Commit**

```bash
git add src/core/views.ts tests/views.test.ts tests/helpers.ts tests/db.test.ts
git commit -m "feat(views): full transaction view plus a lean projection for agents

Storage keeps every field; MCP results do not. Forty-four mostly-null
fields per row spends model context on nothing. verbose:true returns
the full row and the CLI never truncates."
```

---

### Task 4: Update the shared test seed

Split from Task 5 because the seed change is mechanical and touches every downstream suite, while the query change is behavioural. A reviewer can accept one and reject the other.

**Files:**
- Modify: `tests/helpers.ts:41-56`

**Interfaces:**
- Consumes: `TransactionRow` from Task 1.
- Produces: `seedDb(): Db` — unchanged signature. Rows `t1` and `t2` now share `merchant_entity_id: 'ent_amazon'` under two different `counterparty` names, giving Task 5 a real name-variant case to collapse.

- [ ] **Step 1: Rewrite the transaction seed**

Replace the `const t = ...` helper and the `upsertTransactions` call in `tests/helpers.ts` with:

```ts
  // Only the fields a test asserts on carry values; the other 30 are null. This
  // is the inverse of `fullTransactionRow`, which is all-non-null so it can
  // catch a column dropped from the upsert.
  const t = (id: string, over: Partial<TransactionRow>): TransactionRow => ({
    id, account_id: 'acc_1', date: '2026-08-10', description: 'X', amount_cents: 1000,
    category_primary: null, category_detailed: null, counterparty: null,
    status: 'posted', pending_transaction_id: null,
    authorized_date: null, authorized_datetime: null, datetime: null,
    original_description: null,
    iso_currency_code: 'USD', unofficial_currency_code: null,
    category_confidence: null, category_icon_url: null,
    merchant_entity_id: null, merchant_category_code: null,
    website: null, logo_url: null,
    counterparty_type: null, counterparties_json: null,
    payment_channel: 'in store', transaction_code: null,
    check_number: null, account_owner: null,
    location_address: null, location_city: null, location_region: null,
    location_postal_code: null, location_country: null,
    location_lat: null, location_lon: null, location_store_number: null,
    payment_meta_reference_number: null, payment_meta_ppd_id: null,
    payment_meta_payee: null, payment_meta_by_order_of: null,
    payment_meta_payer: null, payment_meta_payment_method: null,
    payment_meta_payment_processor: null, payment_meta_reason: null,
    ...over,
  });

  upsertTransactions(db, [
    // t1 and t2 share a merchant entity under two different display names. This
    // is the case merchant grouping has to collapse.
    t('t1', { amount_cents: 5000, category_primary: 'GROCERIES', counterparty: 'Amazon',
              merchant_entity_id: 'ent_amazon', date: '2026-08-01',
              original_description: 'AMAZON MKTPL', payment_channel: 'online' }),
    t('t2', { amount_cents: 3000, category_primary: 'GROCERIES', counterparty: 'AMZN Mktp US',
              merchant_entity_id: 'ent_amazon', date: '2026-08-05',
              original_description: 'AMZN MKTP US*2K4', payment_channel: 'online' }),
    t('t3', { amount_cents: 2000, category_primary: 'FOOD_AND_DRINK', counterparty: 'Blue Bottle',
              date: '2026-07-20', authorized_date: '2026-07-19',
              category_confidence: 'VERY_HIGH', location_city: 'Oakland', location_region: 'CA' }),
    t('t4', { amount_cents: -200_000, category_primary: 'INCOME', counterparty: 'Employer',
              date: '2026-08-01', payment_channel: 'other', transaction_code: 'direct deposit' }),
    t('t5', { amount_cents: 9900, category_primary: 'FOOD_AND_DRINK', counterparty: 'Sushi',
              status: 'pending', date: '2026-08-15' }),
    t('t6', { amount_cents: 4000, category_primary: 'TRAVEL', counterparty: 'BART',
              account_id: 'acc_2', date: '2026-08-08' }),
  ]);
```

`t1`'s counterparty changed from `Costco` to `Amazon`. Any existing assertion naming Costco must be updated; the grouping behaviour under test is what matters, not the merchant's name.

- [ ] **Step 2: Run the suite**

Run: `pnpm test`
Expected: `db`, `sync`, `views`, `money`, `dates`, `format`, `config`, `init`, `prompt`, `link`, `items` PASS. `queries` and `mcp` FAIL only where they assert on `Costco` or on merchant grouping. Fix the `Costco` assertions to name `Amazon`; leave grouping expectations alone — Task 5 owns those.

- [ ] **Step 3: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS. Every `TransactionRow` literal in the test tree is now complete.

- [ ] **Step 4: Commit**

```bash
git add tests/helpers.ts tests/queries.test.ts tests/mcp.test.ts
git commit -m "test: seed the new transaction fields, add a merchant name-variant case"
```

---

### Task 5: Group merchants by entity, add payment_channel grouping, search memos

**Files:**
- Modify: `src/core/queries.ts:59` (search), `:88` (`SpendingGroupBy`), `:105-111` (`GROUP_EXPR`), `:158-186` (`spendingSummary`)
- Modify: `src/mcp/server.ts` — `spending_summary` groupBy enum, and both tool descriptions
- Test: `tests/queries.test.ts`

**Interfaces:**
- Consumes: `TransactionRow` from Task 1, the seed from Task 4.
- Produces:
  ```ts
  export type SpendingGroupBy =
    | 'category' | 'merchant' | 'month' | 'account' | 'payment_channel';
  ```
  `SpendingGroup` is unchanged: `{ key: string; totalCents: number; count: number; share: number }`. For `merchant`, `key` is the display name while rows are grouped on `merchant_entity_id` when present.

- [ ] **Step 1: Write the failing tests**

Add to `tests/queries.test.ts`:

```ts
describe('merchant grouping', () => {
  it('collapses name variants that share a merchant entity id', () => {
    const db = seedDb();

    const { groups } = spendingSummary(
      db,
      { from: '2026-08-01', to: '2026-08-31', groupBy: 'merchant' },
      () => NOW,
    );

    const amazon = groups.filter(g => g.key === 'Amazon' || g.key === 'AMZN Mktp US');
    expect(amazon).toHaveLength(1);
    expect(amazon[0]?.count).toBe(2);
    expect(amazon[0]?.totalCents).toBe(8000);
  });

  it('still groups by name when no entity id is present', () => {
    const db = seedDb();

    const { groups } = spendingSummary(
      db,
      { from: '2026-07-01', to: '2026-07-31', groupBy: 'merchant' },
      () => NOW,
    );

    expect(groups.map(g => g.key)).toContain('Blue Bottle');
  });
});

describe('payment_channel grouping', () => {
  it('totals spending by channel', () => {
    const db = seedDb();

    const { groups } = spendingSummary(
      db,
      { from: '2026-08-01', to: '2026-08-31', groupBy: 'payment_channel' },
      () => NOW,
    );

    const online = groups.find(g => g.key === 'online');
    expect(online?.totalCents).toBe(8000);
    expect(online?.count).toBe(2);
  });
});

describe('search', () => {
  it('matches the raw bank memo as well as the cleaned description', () => {
    const db = seedDb();

    const { transactions } = listTransactions(db, { search: 'AMZN MKTP US*2K4' }, () => NOW);

    expect(transactions.map(t => t.id)).toEqual(['t2']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/queries.test.ts -t "merchant grouping"`
Expected: FAIL — two Amazon rows instead of one; `payment_channel` rejected as a groupBy; the memo search returns nothing.

- [ ] **Step 3: Split the group key from the display key**

In `src/core/queries.ts`, replace the `GROUP_EXPR` constant (currently `:105-111`) with:

```ts
/**
 * How rows are bucketed. Merchant buckets on the stable entity id so
 * "Amazon" and "AMZN Mktp US*2K4" land together, falling back to the display
 * name for institutions that report no entity id.
 */
const GROUP_EXPR: Record<SpendingGroupBy, string> = {
  category: "COALESCE(category_primary, 'UNCATEGORIZED')",
  merchant:
    "COALESCE(NULLIF(merchant_entity_id, ''), NULLIF(counterparty, ''), 'unknown')",
  month: 'substr(date, 1, 7)',
  account: 'account_id',
  payment_channel: "COALESCE(NULLIF(payment_channel, ''), 'other')",
};

/**
 * What the bucket is called in the output. Identical to GROUP_EXPR except for
 * merchant, where the bucket is an opaque entity id nobody wants to read — so
 * the label is a name drawn from the bucket's rows instead.
 *
 * MIN() rather than MAX() only for determinism; any row's name is equally valid
 * and they are variants of the same merchant by construction.
 */
const KEY_EXPR: Record<SpendingGroupBy, string> = {
  ...GROUP_EXPR,
  merchant: "COALESCE(MIN(NULLIF(counterparty, '')), 'unknown')",
};
```

- [ ] **Step 4: Widen the groupBy union and the SQL**

Change the `SpendingGroupBy` declaration (currently `:88`) to:

```ts
export type SpendingGroupBy =
  | 'category'
  | 'merchant'
  | 'month'
  | 'account'
  | 'payment_channel';
```

In `spendingSummary`, change the `SELECT` so the label and the bucket come from different expressions:

```ts
  const rows = db
    .prepare(
      // Totals are reported as positive magnitudes regardless of direction, so a
      // caller comparing groups never has to reason about the sign. Summing
      // INTEGER cents is exact — no rounding error can accumulate here.
      `SELECT ${KEY_EXPR[f.groupBy]} AS key,
              SUM(ABS(amount_cents)) AS totalCents,
              COUNT(*) AS count
       FROM transactions
       WHERE ${clauses.join(' AND ')}
       GROUP BY ${GROUP_EXPR[f.groupBy]}
       ORDER BY totalCents DESC`,
    )
    .all(params) as Array<{ key: string; totalCents: number; count: number }>;
```

`KEY_EXPR.merchant` is an aggregate (`MIN`) while the others are plain columns. Both are legal in a `SELECT` with an explicit `GROUP BY`; the non-aggregate cases are functionally dependent on the grouping expression.

- [ ] **Step 5: Extend search to the raw memo**

Replace the search clause (currently `:59`) with:

```ts
  if (f.search !== undefined) {
    // original_description is the raw bank memo. It carries store numbers and
    // reference codes that Plaid strips from `description`, which is exactly
    // what someone pasting a line off a statement will search for.
    clauses.push(
      '(description LIKE @search OR counterparty LIKE @search OR original_description LIKE @search)',
    );
    params['search'] = `%${f.search}%`;
  }
```

- [ ] **Step 6: Run the query tests**

Run: `pnpm vitest run tests/queries.test.ts`
Expected: PASS.

- [ ] **Step 7: Give the CLI the full rows**

`transactionsResultView` is lean by default, so the CLI must opt in or `--json` would silently start dropping fields it used to emit. In `src/cli/index.ts`, find the `transactions` command's call and change it to:

```ts
        transactionsResultView(listTransactions(db, filters), { verbose: true }),
```

Match the surrounding call's actual argument name for `filters`. The CLI writes to a file, a pipe, or `jq`; it has no context budget and must never truncate.

- [ ] **Step 8: Add `verbose` to the MCP tool**

In `src/mcp/server.ts`, add to `list_transactions`'s `inputSchema`:

```ts
        verbose: z
          .boolean()
          .optional()
          .describe(
            'return every stored field instead of the default subset — raw bank memo, ' +
              'full location, payment_meta, merchant logo and website, and the complete ' +
              'counterparties chain. Costs substantially more context per row; ask for it ' +
              'when a specific question needs those fields, not by default.',
          ),
```

and pass it through in that tool's handler:

```ts
        return ok(transactionsResultView(listTransactions(deps.db, args), { verbose: args.verbose }));
```

`args.verbose` flows into `listTransactions` harmlessly as an unrecognised filter key — `txnWhere` reads only the fields it knows. If that ever stops being true, destructure it out at the handler instead.

- [ ] **Step 9: Update the MCP tool surface**

In `src/mcp/server.ts`, in the `spending_summary` registration, change the groupBy schema to:

```ts
        groupBy: z.enum(['category', 'merchant', 'month', 'account', 'payment_channel']),
```

and append this to that tool's description string:

```ts
        'Grouping by merchant collapses spelling variants of the same merchant using ' +
        'Plaid\'s stable entity id, so "Amazon" and "AMZN Mktp US*2K4" total as one row. ' +
        'Grouping by payment_channel splits online, in store, and other.',
```

Append to the `list_transactions` description string:

```ts
        'Rows carry category_confidence (VERY_HIGH to UNKNOWN, or null) — treat a LOW or ' +
        'UNKNOWN category as a guess rather than a fact. authorized_date is when the ' +
        'purchase happened and date is when it posted; use authorized_date when it is ' +
        'present and the question is about a specific day. counterparty_type of ' +
        '\'payment_app\' means counterparty is Venmo, Cash App, or similar — the app, not ' +
        'whoever was actually paid.',
```

- [ ] **Step 10: Run the whole suite**

Run: `pnpm test && pnpm typecheck`
Expected: PASS, everything.

- [ ] **Step 11: Update the README**

In `README.md`, replace the paragraph under **State** beginning "The database records its schema version" with:

```markdown
The database records its schema version in `PRAGMA user_version` and the Plaid
environment that created it. There are no migrations: a database written by an
incompatible build, or opened under the wrong environment, is rejected with an
explanation rather than silently misbehaving.

That policy is only tenable while nothing is linked. Deleting the database
destroys the access tokens, which is the one thing Plaid will not resend, so
once you have real banks connected a rejected database means re-linking all of
them and spending Item slots. **Make schema changes before you link, or expect
to pay for them.**
```

Add a new subsection after **Amounts are stored as integer cents**:

```markdown
### What is stored per transaction

Beyond amount, date, and description, each row carries Plaid's enrichment:
`authorized_date` (when the purchase happened, as opposed to `date`, when it
posted), `original_description` (the raw bank memo), `category_confidence`,
`merchant_entity_id` (a stable merchant key), `counterparty_type`,
`payment_channel`, `transaction_code`, and `location_city` / `location_region`.

Two of these change how results read. `spending --group-by merchant` buckets on
`merchant_entity_id`, so spelling variants of one merchant total as a single
row. A `counterparty_type` of `payment_app` means the counterparty is Venmo or
similar — the app, not whoever was actually paid.

`spending --group-by payment_channel` splits online, in store, and other.
```

- [ ] **Step 12: Commit**

```bash
git add src/core/queries.ts src/mcp/server.ts tests/queries.test.ts README.md
git commit -m "feat(queries): group merchants by entity id, add payment_channel, search memos"
```

---

## Self-Review

**Spec coverage.** Feature 1 asks for every `/transactions/sync` field stored — 34 columns (Task 1), mapped at ingest (Task 2), exposed at the output boundary (Task 3) — plus the corrected version-0 error message and the recorded policy expiry (Task 1 Steps 4–5), the CLI/MCP projection split (Task 3 Steps 4–5, Task 5 Steps 7–8), and merchant grouping by entity id, `payment_channel` grouping, and search over `original_description` (Task 5). Task 4 exists only to keep the shared seed compiling between Tasks 1 and 5. Success criteria 1 and 2 are the last two cases in Task 1 Step 1; criterion 3 is the first case in Task 5 Step 1; criterion 7 is a step in every task.

**Placeholders.** None. Every code step carries the literal text to write, except Task 4 Step 1's `fullTransactionRow`, which names the Task 1 literal it moves rather than reprinting 44 lines — the point of the move is that only one copy exists.

**Type consistency.** `TransactionRow` is defined once in Task 1 and consumed unchanged by Tasks 2, 3, and 4. `TXN_COLUMNS` and `TransactionRow` are held in agreement by the `ColumnsMatchRow` guard, which was verified to error in both drift directions and to name the offending field. `payment_channel` is `string` in the row type and `TEXT NOT NULL` in the column, which agree because there is no `ALTER TABLE` forcing a nullable compromise. `LeanTransactionView` is a `Pick` of `TransactionView`, so a renamed field breaks compilation rather than silently vanishing from tool output. `SpendingGroupBy` gains `payment_channel` in Task 5, and both `GROUP_EXPR` and `KEY_EXPR` are `Record<SpendingGroupBy, string>`, so a missing arm fails compilation.

**Two conventions deliberately broken, in opposite directions.** `transactionView` spreads instead of listing fields — at 44 fields the list stopped catching mistakes and started causing them, and the `Omit` type already enforces completeness. `leanTransactionView` lists every field explicitly, because it is an editorial choice about what an agent sees and must not widen automatically when a column is added.

**What changed across drafts.** The first version opened with an additive migration runner, on the reasoning that widening a table costs Item slots. True only after a production bank is linked, and none is — `src/core/db.ts` had already made that call, and building one anyway was speculative infrastructure for a database with no users. The second version stored ten curated fields; that was overruled in favour of storing everything, which is the right call for data that is only free to re-fetch until the first link. The surviving idea from both rounds is the pair of things that were actually load-bearing: the policy's expiry is now written down, and the error message that falsely promised no data loss is fixed.

**Standing risks.**

- Everything here assumes no production Item exists. If one is linked before this lands, stop and reintroduce migrations — the `rm` in Task 1 Step 7 would otherwise destroy access tokens.
- The lean/verbose split is a judgement call about the fifteen fields an agent needs. It is reversible in one line (`transactionsResultView`'s default), and worth revisiting once there is real usage to look at.
