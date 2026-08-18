import fs from 'node:fs';
import {
  ConfigError,
  configPathFor,
  loadConfig,
  writeConfig,
  type ConfigInput,
  type PlaidEnvironment,
} from '../core/config.js';
import { openDb } from '../core/db.js';
import { PlaidApiError, type LinkTokenResult } from '../core/plaid-client.js';

export class InitError extends Error {
  override readonly name = 'InitError';
}

const KEYS_URL = 'https://dashboard.plaid.com/developers/keys';
const ENVIRONMENTS: readonly PlaidEnvironment[] = ['sandbox', 'production'];

/** Bounded: a user who cannot paste working keys in three tries needs the dashboard, not a fourth prompt. */
const MAX_CREDENTIAL_ATTEMPTS = 3;

/** The one call `init` makes against Plaid. Narrow on purpose — verification needs nothing else. */
export interface VerifyApi {
  createLinkToken(opts: Record<string, never>): Promise<LinkTokenResult>;
}

export interface InitPrompter {
  select<T extends string>(question: string, choices: readonly T[], fallback: T): Promise<T>;
  line(question: string): Promise<string>;
  secret(question: string): Promise<string>;
  confirm(question: string, fallback: boolean): Promise<boolean>;
}

export interface InitDeps {
  /**
   * Built lazily, and only once the config path is known to be writable. The
   * real implementation demands a TTY, so constructing it eagerly would report
   * "needs an interactive terminal" for a run whose actual problem is that a
   * config already exists.
   */
  makePrompter: () => InitPrompter;
  openUrl: (url: string) => void;
  write: (message: string) => void;
  makeApi: (cfg: ConfigInput) => VerifyApi;
  env?: NodeJS.ProcessEnv | undefined;
  force?: boolean | undefined;
}

export interface InitResult {
  configPath: string;
  environment: PlaidEnvironment;
  /** False when the keys are valid but Hosted Link is not enabled for this client_id. */
  hostedLinkReady: boolean;
  /** True when the user asked to link a bank right away. */
  linkNow: boolean;
}

/**
 * True for the errors that mean "the credentials you pasted are wrong", as
 * opposed to "Plaid is having a bad day". Only the former is worth re-prompting
 * for; re-asking for keys during an outage sends the user hunting a typo that
 * does not exist.
 */
function isCredentialError(error: unknown): boolean {
  return (
    error instanceof PlaidApiError &&
    (error.errorCode === 'INVALID_API_KEYS' ||
      error.errorCode === 'INVALID_CLIENT_ID' ||
      error.errorCode === 'INVALID_SECRET' ||
      error.errorCode === 'UNAUTHORIZED_ENVIRONMENT')
  );
}

/** Prompts until both fields are non-empty. Bounded, and never echoes the secret. */
async function readCredentials(
  deps: InitDeps,
  prompter: InitPrompter,
  environment: PlaidEnvironment,
): Promise<{ clientId: string; secret: string }> {
  for (let attempt = 0; attempt < MAX_CREDENTIAL_ATTEMPTS; attempt++) {
    const clientId = (await prompter.line('client_id: ')).trim();
    if (clientId === '') {
      deps.write('client_id cannot be empty.');
      continue;
    }
    const secret = (await prompter.secret(`${environment} secret: `)).trim();
    if (secret === '') {
      deps.write('secret cannot be empty.');
      continue;
    }
    return { clientId, secret };
  }
  throw new InitError('No credentials entered. Re-run `ledger init` when you have your keys.');
}

/**
 * Confirms the keys work before anything is written to disk.
 *
 * `/link/token/create` is the cheapest call that proves all three things setup
 * can get wrong at once: the keys are valid, they belong to the environment the
 * user picked, and Hosted Link — which this tool cannot work without — is
 * enabled. The minted token is discarded; link tokens expire on their own.
 */
async function captureVerifiedCredentials(
  deps: InitDeps,
  prompter: InitPrompter,
  environment: PlaidEnvironment,
): Promise<{ input: ConfigInput; hostedLinkReady: boolean }> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_CREDENTIAL_ATTEMPTS; attempt++) {
    const { clientId, secret } = await readCredentials(deps, prompter, environment);
    const input: ConfigInput = { clientId, secret, environment };

    deps.write('Verifying with Plaid…');
    try {
      const result = await deps.makeApi(input).createLinkToken({});
      return { input, hostedLinkReady: result.hostedLinkUrl !== null };
    } catch (error) {
      // A non-credential failure is not something a re-paste can fix.
      if (!isCredentialError(error)) throw error;
      lastError = error;
      deps.write(
        `Plaid rejected those credentials for ${environment}. ` +
          `Check you copied the ${environment} secret, not the other one.`,
      );
    }
  }

  throw new InitError(
    `Could not verify credentials after ${MAX_CREDENTIAL_ATTEMPTS} attempts. ` +
      `Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

/**
 * Interactive first-run setup: choose an environment, collect and verify Plaid
 * credentials, and write config.json at mode 600.
 *
 * Plaid has no API for fetching developer credentials — they exist only in the
 * dashboard — so this opens the keys page and takes a paste. There is no way to
 * automate that half.
 */
export async function runInit(deps: InitDeps): Promise<InitResult> {
  const env = deps.env ?? process.env;
  const targetPath = configPathFor(env);

  // Checked before the prompter is even built: refusing after the user has
  // typed a secret wastes their time, and the TTY requirement is irrelevant to
  // a run that cannot proceed anyway.
  const exists = fs.existsSync(targetPath);
  if (exists && deps.force !== true) {
    throw new ConfigError(
      `${targetPath} already exists. Re-run with --force to replace it, but note that ` +
        `changing credentials invalidates the access tokens your linked banks use.`,
    );
  }

  const prompter = deps.makePrompter();

  if (exists) {
    const confirmed = await prompter.confirm(
      `Overwrite ${targetPath}? Linked banks were created under the existing credentials.`,
      false,
    );
    if (!confirmed) throw new InitError('Cancelled. Nothing was written.');
  }

  const environment = await prompter.select('Which Plaid environment?', ENVIRONMENTS, 'sandbox');

  deps.write(
    `Opening ${KEYS_URL}\n` +
      `Copy your client_id and the ${environment} secret from Developers → Keys.`,
  );
  deps.openUrl(KEYS_URL);

  const { input, hostedLinkReady } = await captureVerifiedCredentials(deps, prompter, environment);

  const configPath = writeConfig(input, { env, force: deps.force ?? false });
  deps.write(`Wrote ${configPath} (mode 600).`);

  // Reading it straight back proves the round trip, and gives us the db path
  // without duplicating the directory logic here.
  const cfg = loadConfig(env);
  openDb(cfg.dbPath, cfg.environment).close();

  if (!hostedLinkReady) {
    deps.write(
      'Warning: Plaid returned no hosted_link_url. Your keys are valid, but Hosted Link ' +
        'is not enabled for this client_id, and `ledger auth` needs it. Enable it under ' +
        'Dashboard → Developers before linking a bank.',
    );
  }

  const linkNow = hostedLinkReady ? await prompter.confirm('Link a bank now?', false) : false;

  return { configPath, environment, hostedLinkReady, linkNow };
}
