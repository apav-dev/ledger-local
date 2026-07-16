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
    // Note: intersecting a `dispatcher?: Agent` field directly with the global
    // `RequestInit` makes TS merge the property into `Dispatcher & Agent`, which
    // fails to typecheck because @types/node's bundled `undici-types` (8.3.0) has
    // drifted from the installed `undici` package (8.7.0). Building the init object
    // against a local, non-intersected shape and casting once at the `fetch()`
    // boundary avoids that version-skew collision while keeping `dispatcher` real
    // for Node's undici-backed fetch implementation.
    const init: { headers: Record<string, string>; dispatcher?: Agent } = {
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${accessToken}:`).toString('base64'),
        Accept: 'application/json',
      },
    };
    if (this.#dispatcher) init.dispatcher = this.#dispatcher;
    return fetch(this.#baseUrl + apiPath, init as unknown as RequestInit).catch(cause => {
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
