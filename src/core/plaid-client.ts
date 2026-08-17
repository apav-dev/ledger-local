import {
  Configuration,
  CountryCode,
  PlaidApi,
  PlaidEnvironments,
  Products,
  type AccountBase,
  type AccountsGetResponse,
  type ItemPublicTokenExchangeResponse,
  type LinkTokenCreateRequest,
  type LinkTokenCreateResponse,
  type LinkTokenGetResponse,
  type TransactionsSyncResponse,
} from 'plaid';
import type { LedgerConfig, PlaidEnvironment } from './config.js';

/**
 * Sourced from the SDK rather than hardcoded so an SDK upgrade cannot leave us
 * pointing at a stale host, but verified at runtime: a missing key would
 * otherwise silently produce a client with an undefined base URL.
 */
function basePathFor(environment: PlaidEnvironment): string {
  const basePath: string | undefined = PlaidEnvironments[environment];
  if (typeof basePath !== 'string' || basePath.length === 0) {
    throw new Error(`Plaid SDK exposes no base URL for environment "${environment}"`);
  }
  return basePath;
}

/**
 * Named PlaidApiError rather than PlaidError because the SDK already exports an
 * interface by that name for the wire payload.
 */
export class PlaidApiError extends Error {
  override readonly name = 'PlaidApiError';
  constructor(
    message: string,
    readonly errorCode: string | null,
    readonly errorType: string | null,
    readonly status: number | null,
  ) {
    super(message);
  }
}

/** Wire shape of a Plaid error body, duck-typed so axios stays untouched. */
interface WireError {
  error_code?: unknown;
  error_type?: unknown;
  error_message?: unknown;
}

function asWireError(value: unknown): WireError | null {
  if (typeof value !== 'object' || value === null) return null;
  const body = (value as { response?: { data?: unknown } }).response?.data;
  if (typeof body !== 'object' || body === null) return null;
  return body as WireError;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function toPlaidApiError(cause: unknown, label: string): PlaidApiError {
  const wire = asWireError(cause);
  const status =
    typeof (cause as { response?: { status?: unknown } })?.response?.status === 'number'
      ? ((cause as { response: { status: number } }).response.status)
      : null;

  if (wire === null) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return new PlaidApiError(`Network error calling ${label}: ${detail}`, null, null, status);
  }

  const code = str(wire.error_code);
  const message = str(wire.error_message) ?? `Plaid error on ${label}`;
  return new PlaidApiError(
    `${label}: ${message}${code === null ? '' : ` (${code})`}`,
    code,
    str(wire.error_type),
    status,
  );
}

/**
 * The user must re-authenticate through Link update mode. Note this arrives as
 * HTTP 400, not 401 — keying reauth detection off the status code silently
 * never fires.
 */
export function isReauthRequired(error: unknown): boolean {
  return (
    error instanceof PlaidApiError &&
    (error.errorCode === 'ITEM_LOGIN_REQUIRED' || error.errorCode === 'PENDING_EXPIRATION')
  );
}

export function isRateLimited(error: unknown): boolean {
  return error instanceof PlaidApiError && error.errorType === 'RATE_LIMIT_EXCEEDED';
}

/** A freshly linked Item whose first transaction pull has not finished yet. */
export function isProductNotReady(error: unknown): boolean {
  return error instanceof PlaidApiError && error.errorCode === 'PRODUCT_NOT_READY';
}

export interface CreateLinkTokenOpts {
  /** Set to re-link an existing Item through update mode instead of creating a new one. */
  accessToken?: string | undefined;
  redirectUri?: string | undefined;
}

export interface LinkTokenResult {
  linkToken: string;
  /** Absent when Plaid declines to host the session. */
  hostedLinkUrl: string | null;
}

/**
 * The seam sync.ts and link.ts depend on. Tests inject a fake implementing this
 * rather than intercepting HTTP, so no axios mocking is needed anywhere.
 */
export interface LedgerPlaidApi {
  getAccounts(accessToken: string): Promise<AccountBase[]>;
  syncTransactions(
    accessToken: string,
    cursor: string | null,
    count: number,
  ): Promise<TransactionsSyncResponse>;
  createLinkToken(opts: CreateLinkTokenOpts): Promise<LinkTokenResult>;
  getLinkSession(linkToken: string): Promise<LinkTokenGetResponse>;
  exchangePublicToken(publicToken: string): Promise<{ accessToken: string; itemId: string }>;
}

const RATE_LIMIT_DELAY_MS = 2_000;
const PRODUCT_NOT_READY_DELAY_MS = 3_000;
/** Total attempts, not retries. Bounded so no call can spin indefinitely. */
const MAX_ATTEMPTS = 4;

/**
 * The subset of PlaidApi this client uses. `PlaidApi` satisfies it structurally
 * (its AxiosResponse return type carries `data`), and declaring it explicitly
 * makes the SDK injectable — so tests never reach the network.
 */
export interface PlaidSdk {
  accountsBalanceGet(req: { access_token: string }): Promise<{ data: AccountsGetResponse }>;
  transactionsSync(req: {
    access_token: string;
    count: number;
    cursor?: string;
  }): Promise<{ data: TransactionsSyncResponse }>;
  linkTokenCreate(req: LinkTokenCreateRequest): Promise<{ data: LinkTokenCreateResponse }>;
  linkTokenGet(req: { link_token: string }): Promise<{ data: LinkTokenGetResponse }>;
  itemPublicTokenExchange(req: {
    public_token: string;
  }): Promise<{ data: ItemPublicTokenExchangeResponse }>;
}

export function sdkFromConfig(
  cfg: Pick<LedgerConfig, 'clientId' | 'secret' | 'environment'>,
): PlaidSdk {
  return new PlaidApi(
    new Configuration({
      basePath: basePathFor(cfg.environment),
      baseOptions: {
        headers: {
          'PLAID-CLIENT-ID': cfg.clientId,
          'PLAID-SECRET': cfg.secret,
        },
      },
    }),
  );
}

export class PlaidClient implements LedgerPlaidApi {
  readonly #api: PlaidSdk;
  readonly #clientName: string;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(
    cfg: Pick<LedgerConfig, 'clientId' | 'secret' | 'environment'>,
    opts: {
      sleep?: (ms: number) => Promise<void>;
      clientName?: string;
      /** Inject a stub in tests. Defaults to a real SDK bound to cfg. */
      sdk?: PlaidSdk;
    } = {},
  ) {
    this.#sleep = opts.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
    this.#clientName = opts.clientName ?? 'ledger-local';
    this.#api = opts.sdk ?? sdkFromConfig(cfg);
  }

  /**
   * Single funnel for every Plaid call: normalizes errors and applies the retry
   * policy. Fixed-bound loop rather than recursion so the worst case is
   * provable from the constants above.
   */
  async #call<T>(label: string, fn: () => Promise<{ data: T }>): Promise<T> {
    let lastError: PlaidApiError | undefined;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return (await fn()).data;
      } catch (cause) {
        const error = toPlaidApiError(cause, label);
        lastError = error;
        const retryable = isRateLimited(error) || isProductNotReady(error);
        if (!retryable || attempt === MAX_ATTEMPTS) throw error;
        await this.#sleep(
          isRateLimited(error) ? RATE_LIMIT_DELAY_MS : PRODUCT_NOT_READY_DELAY_MS * attempt,
        );
      }
    }
    // Unreachable: the loop either returns or throws. Present so the function
    // has no implicit undefined return path.
    throw lastError ?? new PlaidApiError(`${label}: retry loop exhausted`, null, null, null);
  }

  getAccounts(accessToken: string): Promise<AccountBase[]> {
    return this.#call('/accounts/balance/get', () =>
      this.#api.accountsBalanceGet({ access_token: accessToken }),
    ).then(r => r.accounts);
  }

  syncTransactions(
    accessToken: string,
    cursor: string | null,
    count: number,
  ): Promise<TransactionsSyncResponse> {
    return this.#call('/transactions/sync', () =>
      this.#api.transactionsSync({
        access_token: accessToken,
        count,
        // Omit cursor entirely on first sync; Plaid treats absent as "from the
        // beginning" and rejects an explicit null.
        ...(cursor === null ? {} : { cursor }),
      }),
    );
  }

  createLinkToken(opts: CreateLinkTokenOpts): Promise<LinkTokenResult> {
    return this.#call('/link/token/create', () =>
      this.#api.linkTokenCreate({
        client_name: this.#clientName,
        language: 'en',
        country_codes: [CountryCode.Us],
        user: { client_user_id: 'ledger-local-user' },
        // Update mode reuses the existing Item; products must be omitted then.
        ...(opts.accessToken === undefined
          ? { products: [Products.Transactions] }
          : { access_token: opts.accessToken }),
        ...(opts.redirectUri === undefined ? {} : { redirect_uri: opts.redirectUri }),
        hosted_link: {},
      }),
    ).then(r => ({ linkToken: r.link_token, hostedLinkUrl: r.hosted_link_url ?? null }));
  }

  getLinkSession(linkToken: string): Promise<LinkTokenGetResponse> {
    return this.#call('/link/token/get', () => this.#api.linkTokenGet({ link_token: linkToken }));
  }

  exchangePublicToken(publicToken: string): Promise<{ accessToken: string; itemId: string }> {
    return this.#call('/item/public_token/exchange', () =>
      this.#api.itemPublicTokenExchange({ public_token: publicToken }),
    ).then(r => ({ accessToken: r.access_token, itemId: r.item_id }));
  }
}

export function clientFromConfig(cfg: LedgerConfig): PlaidClient {
  return new PlaidClient(cfg);
}
