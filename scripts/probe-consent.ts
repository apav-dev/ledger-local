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
