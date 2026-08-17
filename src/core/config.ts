import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

/**
 * Plaid retired the Development environment; Sandbox and Production are all
 * that remain. Production on the Trial plan serves real bank data capped at
 * 10 Items.
 */
export type PlaidEnvironment = 'sandbox' | 'production';

const ConfigFileSchema = z.object({
  clientId: z.string().min(1),
  secret: z.string().min(1),
  environment: z.enum(['sandbox', 'production']).default('sandbox'),
});

export interface LedgerConfig {
  clientId: string;
  secret: string;
  environment: PlaidEnvironment;
  configDir: string;
  dbPath: string;
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

export function setupInstructions(configDir: string): string {
  return [
    `Plaid is not configured. To set up:`,
    `  1. Create a Plaid account at https://dashboard.plaid.com/signup.`,
    `     US/CA signups get a Trial plan: real production data, up to 10 Items.`,
    `  2. Copy your client_id and Sandbox (or Production) secret from`,
    `     Dashboard > Developers > Keys.`,
    `  3. Create ${path.join(configDir, 'config.json')} containing:`,
    `       { "clientId": "...", "secret": "...", "environment": "sandbox" }`,
    `  4. chmod 600 that file — it holds a live API secret.`,
    `  5. Run: ledger auth`,
  ].join('\n');
}

/**
 * The secret lives in this file, so a readable-by-others config is a real
 * credential leak. Warn rather than throw: refusing to run would strand a user
 * whose umask created the file loosely, and the fix is a one-line chmod.
 */
function warnIfConfigWorldReadable(configPath: string): void {
  let mode: number;
  try {
    mode = fs.statSync(configPath).mode & 0o777;
  } catch {
    return; // Already read successfully; a stat failure here is not worth failing on.
  }
  if ((mode & 0o077) !== 0) {
    process.stderr.write(
      `warning: ${configPath} is mode ${mode.toString(8)} and holds a Plaid secret. ` +
        `Run: chmod 600 ${configPath}\n`,
    );
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): LedgerConfig {
  const configDir = env['LEDGER_CONFIG_DIR'] ?? path.join(os.homedir(), '.config', 'ledger');
  const dataDir = env['LEDGER_DATA_DIR'] ?? path.join(os.homedir(), '.local', 'share', 'ledger');
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
    // error.message embeds the failing field paths but never the values, so a
    // malformed secret cannot leak into stderr here.
    throw new ConfigError(`Invalid ${configPath}: ${parsed.error.message}`);
  }

  warnIfConfigWorldReadable(configPath);
  fs.mkdirSync(dataDir, { recursive: true });

  return {
    clientId: parsed.data.clientId,
    secret: parsed.data.secret,
    environment: parsed.data.environment,
    configDir,
    dbPath: path.join(dataDir, 'ledger.db'),
  };
}
