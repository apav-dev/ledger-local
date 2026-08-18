import {
  Configuration,
  CountryCode,
  PlaidApi,
  PlaidEnvironments,
  Products,
  type AccountBase,
  type AccountsGetResponse,
  type ItemPublicTokenExchangeResponse,
  type ItemRemoveResponse,
  type LinkTokenCreateRequest,
  type LinkTokenCreateResponse,
  type LinkTokenGetResponse,
  type TransactionsRecurringGetResponse,
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

/**
 * Plaid no longer knows this Item. Removal is the one operation for which this
 * is success rather than failure — there is nothing left to delete upstream.
 */
export function isItemNotFound(error: unknown): boolean {
  return error instanceof PlaidApiError && error.errorCode === 'ITEM_NOT_FOUND';
}

/**
 * Plaid refused the product, not the credentials. Distinct from a reauth: the
 * access token is fine, the entitlement is not.
 *
 * The fix is NOT `ledger auth consent`. A sandbox probe on 2026-08-18 confirmed
 * Plaid rejects `recurring_transactions` and `transactions_refresh` as
 * `additional_consented_products` with INVALID_PRODUCT — they are account-level
 * products enabled in the dashboard, not per-Item consents. Advising the consent
 * command here would send the user somewhere that cannot help them.
 */
export function isConsentRequired(error: unknown): boolean {
  return (
    error instanceof PlaidApiError &&
    (error.errorCode === 'ADDITIONAL_CONSENT_REQUIRED' ||
      error.errorCode === 'PRODUCTS_NOT_SUPPORTED' ||
      error.errorCode === 'INSUFFICIENT_CREDENTIALS')
  );
}

/**
 * Plaid's maximum, and the only safe default.
 *
 * `days_requested` fixes how much history Plaid pulls from the institution when
 * the Item is created. It cannot be raised afterwards — per Plaid, recovering
 * requires `/item/remove` and a fresh trip through Link, which also costs
 * another Item slot. Requesting less than the maximum is therefore a permanent,
 * silent data ceiling, while requesting the maximum only costs a slower first
 * historical pull.
 */
export const MAX_DAYS_REQUESTED = 730;

/**
 * Products consented at link time but never billed until their endpoints are
 * called. Plaid: "These products will not be billed until you start using them
 * by calling the relevant endpoints."
 *
 * Consent is requested up front because obtaining it later means sending the
 * user back through Link in update mode — once per Item, in a browser. Update
 * mode keeps the access_token, item_id, cursor, and Item slot, so deferring is
 * cheap in money and expensive in interruptions. This costs nothing.
 *
 * This list is exactly what Plaid's sandbox accepted on probe; see
 * scripts/probe-consent.ts. Membership in the SDK's `Products` enum is not
 * evidence a name is valid here — the enum is shared across request shapes.
 *
 * Rejected by sandbox probe (INVALID_PRODUCT for additional_consented_products):
 * - recurring_transactions
 * - transactions_refresh
 */
export const CONSENTED_PRODUCTS: readonly Products[] = [
  Products.Liabilities,
  Products.Investments,
];

export interface CreateLinkTokenOpts {
  /** Set to re-link an existing Item through update mode instead of creating a new one. */
  accessToken?: string | undefined;
  redirectUri?: string | undefined;
  /** Days of history to pull on Item creation. Ignored in update mode. */
  daysRequested?: number | undefined;
  /**
   * Consent to collect. Valid in both new-Item and update mode — update mode is
   * the supported way to add consent to an Item that already exists.
   */
  additionalConsentedProducts?: readonly Products[] | undefined;
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
  /** Deletes the Item at Plaid, freeing its slot and invalidating its access token. */
  itemRemove(accessToken: string): Promise<void>;
  /**
   * A full snapshot of every recurring stream on the Item. No cursor, no
   * `removed` list — callers must replace their stored set, not merge into it.
   */
  getRecurringStreams(accessToken: string): Promise<TransactionsRecurringGetResponse>;
}

const RATE_LIMIT_DELAY_MS = 2_000;
/** Total rate-limit attempts, not retries. A rate limit clears quickly or it does not. */
const RATE_LIMIT_MAX_ATTEMPTS = 4;

/**
 * PRODUCT_NOT_READY is a different animal from a rate limit: it means Plaid is
 * still pulling history from the institution. With two years requested on an
 * active account that takes minutes, so this is a poll against a wall-clock
 * budget rather than a handful of quick retries. Backoff starts short — a small
 * Item is ready in seconds — and caps so the poll stays responsive.
 */
const PRODUCT_NOT_READY_BASE_DELAY_MS = 3_000;
const PRODUCT_NOT_READY_MAX_DELAY_MS = 15_000;
const PRODUCT_NOT_READY_BUDGET_MS = 5 * 60_000;

/** Hard backstop across every retry category, so no call can spin indefinitely. */
const MAX_TOTAL_ATTEMPTS = 64;

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
  itemRemove(req: { access_token: string }): Promise<{ data: ItemRemoveResponse }>;
  transactionsRecurringGet(req: {
    access_token: string;
  }): Promise<{ data: TransactionsRecurringGetResponse }>;
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
  readonly #now: () => number;
  readonly #productNotReadyBudgetMs: number;

  constructor(
    cfg: Pick<LedgerConfig, 'clientId' | 'secret' | 'environment'>,
    opts: {
      sleep?: (ms: number) => Promise<void>;
      /** Injected so the poll budget is testable without real elapsed time. */
      now?: () => number;
      productNotReadyBudgetMs?: number;
      clientName?: string;
      /** Inject a stub in tests. Defaults to a real SDK bound to cfg. */
      sdk?: PlaidSdk;
    } = {},
  ) {
    this.#sleep = opts.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
    this.#now = opts.now ?? Date.now;
    this.#productNotReadyBudgetMs = opts.productNotReadyBudgetMs ?? PRODUCT_NOT_READY_BUDGET_MS;
    this.#clientName = opts.clientName ?? 'ledger-local';
    this.#api = opts.sdk ?? sdkFromConfig(cfg);
  }

  /**
   * Single funnel for every Plaid call: normalizes errors and applies the retry
   * policy. Fixed-bound loop rather than recursion so the worst case is
   * provable from the constants above.
   *
   * The two retryable conditions get separate budgets because they mean
   * different things. A rate limit is a handful of quick retries.
   * PRODUCT_NOT_READY is a poll against work Plaid is still doing, and giving up
   * on it after seconds is what made the first sync after linking fail.
   */
  async #call<T>(label: string, fn: () => Promise<{ data: T }>): Promise<T> {
    const start = this.#now();
    let rateLimitAttempts = 0;
    let notReadyAttempts = 0;
    let lastError: PlaidApiError | undefined;

    for (let attempt = 0; attempt < MAX_TOTAL_ATTEMPTS; attempt++) {
      try {
        return (await fn()).data;
      } catch (cause) {
        const error = toPlaidApiError(cause, label);
        lastError = error;

        if (isRateLimited(error)) {
          rateLimitAttempts += 1;
          if (rateLimitAttempts >= RATE_LIMIT_MAX_ATTEMPTS) throw error;
          await this.#sleep(RATE_LIMIT_DELAY_MS);
          continue;
        }

        if (isProductNotReady(error)) {
          // Budgeted on elapsed time rather than attempt count, so the total
          // wait does not change when the backoff curve does. The original
          // error is rethrown so callers can still classify it.
          if (this.#now() - start >= this.#productNotReadyBudgetMs) throw error;
          notReadyAttempts += 1;
          await this.#sleep(
            Math.min(
              PRODUCT_NOT_READY_MAX_DELAY_MS,
              PRODUCT_NOT_READY_BASE_DELAY_MS * notReadyAttempts,
            ),
          );
          continue;
        }

        throw error;
      }
    }
    // Reached only if the backstop trips before either budget does.
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

  getRecurringStreams(accessToken: string): Promise<TransactionsRecurringGetResponse> {
    return this.#call('/transactions/recurring/get', () =>
      this.#api.transactionsRecurringGet({ access_token: accessToken }),
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
        // So must `transactions`: the Item's history depth is already fixed, and
        // Plaid documents the field as having no effect once Transactions has
        // been added to an Item.
        ...(opts.accessToken === undefined
          ? {
              products: [Products.Transactions],
              transactions: { days_requested: opts.daysRequested ?? MAX_DAYS_REQUESTED },
            }
          : { access_token: opts.accessToken }),
        // Sent in BOTH branches. In update mode this is the entire point of the
        // call: it is how consent is added to an Item that already exists.
        ...(opts.additionalConsentedProducts === undefined
          ? {}
          : { additional_consented_products: [...opts.additionalConsentedProducts] }),
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

  /**
   * Irreversible at Plaid. The access token stops working immediately and the
   * Item's slot is freed; recovering the connection means a fresh trip through
   * Link, which creates a new Item with a new id.
   */
  itemRemove(accessToken: string): Promise<void> {
    return this.#call('/item/remove', () =>
      this.#api.itemRemove({ access_token: accessToken }),
    ).then(() => undefined);
  }
}

export function clientFromConfig(cfg: LedgerConfig): PlaidClient {
  return new PlaidClient(cfg);
}
