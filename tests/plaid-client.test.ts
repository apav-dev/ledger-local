import { describe, expect, it } from 'vitest';
import type { LinkTokenCreateRequest } from 'plaid';
import type { TransactionsRecurringGetResponse, TransactionsRefreshResponse } from 'plaid';
import {
  CONSENTED_PRODUCTS,
  PlaidApiError,
  PlaidClient,
  isConsentRequired,
  isProductNotReady,
  isRateLimited,
  isReauthRequired,
  toPlaidApiError,
  type PlaidSdk,
} from '../src/core/plaid-client.js';

/** Shapes an axios-style rejection the way the Plaid SDK surfaces one. */
function wireError(
  status: number,
  body: { error_code?: string; error_type?: string; error_message?: string },
): unknown {
  return { response: { status, data: body } };
}

const CFG = { clientId: 'cid', secret: 'sec', environment: 'sandbox' as const };

describe('toPlaidApiError', () => {
  it('extracts code, type, status, and message from a Plaid error body', () => {
    const error = toPlaidApiError(
      wireError(400, {
        error_code: 'ITEM_LOGIN_REQUIRED',
        error_type: 'ITEM_ERROR',
        error_message: 'the login details of this item have changed',
      }),
      '/transactions/sync',
    );
    expect(error).toBeInstanceOf(PlaidApiError);
    expect(error.errorCode).toBe('ITEM_LOGIN_REQUIRED');
    expect(error.errorType).toBe('ITEM_ERROR');
    expect(error.status).toBe(400);
    expect(error.message).toContain('/transactions/sync');
    expect(error.message).toContain('login details');
  });

  it('degrades to a network error when there is no Plaid body', () => {
    const error = toPlaidApiError(new Error('ECONNREFUSED'), '/accounts/balance/get');
    expect(error.errorCode).toBeNull();
    expect(error.errorType).toBeNull();
    expect(error.message).toContain('Network error');
    expect(error.message).toContain('ECONNREFUSED');
  });

  it('does not treat a non-object rejection as a Plaid body', () => {
    const error = toPlaidApiError('boom', '/link/token/get');
    expect(error.errorCode).toBeNull();
    expect(error.message).toContain('boom');
  });
});

describe('error classification', () => {
  it('detects reauth from error_code, not HTTP status', () => {
    // Plaid sends ITEM_LOGIN_REQUIRED as HTTP 400. Keying off 401 never fires.
    const error = toPlaidApiError(
      wireError(400, { error_code: 'ITEM_LOGIN_REQUIRED', error_type: 'ITEM_ERROR' }),
      'x',
    );
    expect(error.status).toBe(400);
    expect(isReauthRequired(error)).toBe(true);
  });

  it('treats PENDING_EXPIRATION as reauth too', () => {
    const error = toPlaidApiError(
      wireError(400, { error_code: 'PENDING_EXPIRATION', error_type: 'ITEM_ERROR' }),
      'x',
    );
    expect(isReauthRequired(error)).toBe(true);
  });

  it('does not confuse an unrelated 400 with reauth', () => {
    const error = toPlaidApiError(
      wireError(400, { error_code: 'INVALID_FIELD', error_type: 'INVALID_REQUEST' }),
      'x',
    );
    expect(isReauthRequired(error)).toBe(false);
  });

  it('classifies rate limits by error_type', () => {
    const error = toPlaidApiError(
      wireError(429, { error_code: 'TRANSACTIONS_LIMIT', error_type: 'RATE_LIMIT_EXCEEDED' }),
      'x',
    );
    expect(isRateLimited(error)).toBe(true);
    expect(isReauthRequired(error)).toBe(false);
  });

  it('classifies PRODUCT_NOT_READY', () => {
    const error = toPlaidApiError(
      wireError(400, { error_code: 'PRODUCT_NOT_READY', error_type: 'ITEM_ERROR' }),
      'x',
    );
    expect(isProductNotReady(error)).toBe(true);
  });

  it('classifies nothing for a plain Error', () => {
    expect(isReauthRequired(new Error('x'))).toBe(false);
    expect(isRateLimited(new Error('x'))).toBe(false);
    expect(isProductNotReady(new Error('x'))).toBe(false);
  });
});

/**
 * Injects a stub SDK so no test can reach the network, and records sleep
 * durations so the retry policy is observable without real timers.
 */
function clientWithStub(stub: Record<string, unknown>, sleeps: number[]): PlaidClient {
  return new PlaidClient(CFG, {
    sleep: async ms => void sleeps.push(ms),
    // Stubs are deliberately partial — each test implements only the endpoint
    // it exercises and returns only the fields the client reads. Building
    // complete Plaid response objects here would obscure what is under test.
    sdk: stub as unknown as PlaidSdk,
  });
}

describe('retry policy', () => {
  it('retries a rate-limited call and succeeds on the second attempt', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const client = clientWithStub(
      {
        accountsBalanceGet: async () => {
          calls += 1;
          if (calls === 1) {
            throw wireError(429, {
              error_code: 'TRANSACTIONS_LIMIT',
              error_type: 'RATE_LIMIT_EXCEEDED',
            });
          }
          return { data: { accounts: [{ account_id: 'acc_1' }] } };
        },
      },
      sleeps,
    );

    const accounts = await client.getAccounts('tok');
    expect(calls).toBe(2);
    expect(sleeps).toEqual([2000]);
    expect(accounts).toHaveLength(1);
  });

  it('exhausts rate-limit retries bounded', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const client = clientWithStub(
      {
        accountsBalanceGet: async () => {
          calls += 1;
          throw wireError(429, {
            error_code: 'TRANSACTIONS_LIMIT',
            error_type: 'RATE_LIMIT_EXCEEDED',
          });
        },
      },
      sleeps,
    );

    await expect(client.getAccounts('tok')).rejects.toSatisfy(isRateLimited);
    expect(calls).toBe(4);
    expect(sleeps).toEqual([2000, 2000, 2000]);
  });

  it('polls PRODUCT_NOT_READY for minutes, not seconds', async () => {
    // A production Item requesting two years of history takes minutes to finish
    // its historical pull. An 18-second budget guaranteed that the sync run
    // immediately after linking would fail.
    const sleeps: number[] = [];
    let calls = 0;
    let clock = 0;
    const client = new PlaidClient(CFG, {
      sleep: async ms => {
        sleeps.push(ms);
        clock += ms; // the injected clock advances only by time actually slept
      },
      now: () => clock,
      sdk: {
        transactionsSync: async () => {
          calls += 1;
          throw wireError(400, { error_code: 'PRODUCT_NOT_READY', error_type: 'ITEM_ERROR' });
        },
      } as unknown as PlaidSdk,
    });

    await expect(client.syncTransactions('tok', null, 500)).rejects.toSatisfy(isProductNotReady);

    const totalSlept = sleeps.reduce((a, b) => a + b, 0);
    expect(totalSlept).toBeGreaterThanOrEqual(4 * 60_000);
    expect(sleeps[0]).toBe(3000); // stays responsive for an Item that is ready quickly
    expect(Math.max(...sleeps)).toBe(15_000); // capped, not exponential forever
    expect(calls).toBeGreaterThan(15);
    expect(calls).toBeLessThan(64); // still bounded
  });

  it('gives up on PRODUCT_NOT_READY once the budget is spent', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    let clock = 0;
    const client = new PlaidClient(CFG, {
      sleep: async ms => {
        sleeps.push(ms);
        clock += ms;
      },
      now: () => clock,
      productNotReadyBudgetMs: 10_000,
      sdk: {
        transactionsSync: async () => {
          calls += 1;
          throw wireError(400, { error_code: 'PRODUCT_NOT_READY', error_type: 'ITEM_ERROR' });
        },
      } as unknown as PlaidSdk,
    });

    // The original error code survives, so callers can still classify it.
    await expect(client.syncTransactions('tok', null, 500)).rejects.toSatisfy(isProductNotReady);
    expect(calls).toBeLessThan(6);
  });

  it('returns as soon as PRODUCT_NOT_READY clears', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const client = clientWithStub(
      {
        transactionsSync: async () => {
          calls += 1;
          if (calls < 3) {
            throw wireError(400, { error_code: 'PRODUCT_NOT_READY', error_type: 'ITEM_ERROR' });
          }
          return {
            data: { added: [], modified: [], removed: [], next_cursor: 'c', has_more: false },
          };
        },
      },
      sleeps,
    );

    await client.syncTransactions('tok', null, 500);
    expect(calls).toBe(3);
    expect(sleeps).toEqual([3000, 6000]);
  });

  it('does not retry a non-retryable error', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const client = clientWithStub(
      {
        transactionsSync: async () => {
          calls += 1;
          throw wireError(400, { error_code: 'ITEM_LOGIN_REQUIRED', error_type: 'ITEM_ERROR' });
        },
      },
      sleeps,
    );

    await expect(client.syncTransactions('tok', null, 500)).rejects.toSatisfy(isReauthRequired);
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  });
});

describe('request shaping', () => {
  it('omits cursor entirely on a first sync', async () => {
    // Plaid rejects an explicit null cursor; absent means "from the beginning".
    let seen: Record<string, unknown> | undefined;
    const client = clientWithStub(
      {
        transactionsSync: async (req: Record<string, unknown>) => {
          seen = req;
          return { data: { added: [], modified: [], removed: [], next_cursor: 'c', has_more: false } };
        },
      },
      [],
    );
    await client.syncTransactions('tok', null, 500);
    expect(seen).not.toHaveProperty('cursor');
    expect(seen).toMatchObject({ access_token: 'tok', count: 500 });
  });

  it('sends the cursor on subsequent syncs', async () => {
    let seen: Record<string, unknown> | undefined;
    const client = clientWithStub(
      {
        transactionsSync: async (req: Record<string, unknown>) => {
          seen = req;
          return { data: { added: [], modified: [], removed: [], next_cursor: 'c2', has_more: false } };
        },
      },
      [],
    );
    await client.syncTransactions('tok', 'c1', 500);
    expect(seen).toMatchObject({ cursor: 'c1' });
  });

  it('requests products on a new link but access_token on an update-mode link', async () => {
    // Update mode must not send products, and must reuse the Item's token so
    // repair does not create a second Item.
    const seen: Array<Record<string, unknown>> = [];
    const client = clientWithStub(
      {
        linkTokenCreate: async (req: Record<string, unknown>) => {
          seen.push(req);
          return { data: { link_token: 'link-1', hosted_link_url: 'https://secure.plaid.com/x' } };
        },
      },
      [],
    );

    await client.createLinkToken({});
    await client.createLinkToken({ accessToken: 'access-existing' });

    expect(seen[0]).toHaveProperty('products');
    expect(seen[0]).not.toHaveProperty('access_token');
    expect(seen[1]).toHaveProperty('access_token', 'access-existing');
    expect(seen[1]).not.toHaveProperty('products');
    expect(seen[0]).toHaveProperty('hosted_link');
  });

  it('reports a missing hosted_link_url as null rather than undefined', async () => {
    const client = clientWithStub(
      { linkTokenCreate: async () => ({ data: { link_token: 'link-1' } }) },
      [],
    );
    expect(await client.createLinkToken({})).toEqual({
      linkToken: 'link-1',
      hostedLinkUrl: null,
    });
  });
});

describe('transaction history depth', () => {
  /** Captures the link token request without reaching the network. */
  function linkTokenSpy(): { client: PlaidClient; seen: () => Record<string, unknown> | undefined } {
    let seen: Record<string, unknown> | undefined;
    const client = clientWithStub(
      {
        linkTokenCreate: async (req: Record<string, unknown>) => {
          seen = req;
          return { data: { link_token: 'l', hosted_link_url: 'https://x' } };
        },
      },
      [],
    );
    return { client, seen: () => seen };
  }

  it('requests Plaid maximum history on a new link', async () => {
    // days_requested is fixed when the Item is created and can never be raised
    // afterwards — recovering means /item/remove plus a fresh Link, which costs
    // another Item slot. Defaulting to the maximum makes the irreversible
    // choice the non-destructive one.
    const { client, seen } = linkTokenSpy();
    await client.createLinkToken({});
    expect(seen()).toMatchObject({ transactions: { days_requested: 730 } });
  });

  it('accepts an explicit override', async () => {
    const { client, seen } = linkTokenSpy();
    await client.createLinkToken({ daysRequested: 180 });
    expect(seen()).toMatchObject({ transactions: { days_requested: 180 } });
  });

  it('omits days_requested in update mode', async () => {
    // Update mode repairs an existing Item whose history depth is already
    // fixed, so the field is inert at best.
    const { client, seen } = linkTokenSpy();
    await client.createLinkToken({ accessToken: 'access-existing' });
    expect(seen()).not.toHaveProperty('transactions');
  });
});

describe('additional_consented_products', () => {
  it('sends the consent list when creating a new Item', async () => {
    const calls: LinkTokenCreateRequest[] = [];
    const client = clientWithStub(
      {
        linkTokenCreate: async (req: LinkTokenCreateRequest) => {
          calls.push(req);
          return { data: { link_token: 'lt', hosted_link_url: 'https://h', request_id: 'r' } };
        },
      },
      [],
    );

    await client.createLinkToken({ additionalConsentedProducts: CONSENTED_PRODUCTS });

    expect(calls[0]?.additional_consented_products).toEqual([...CONSENTED_PRODUCTS]);
    expect(calls[0]?.products).toEqual(['transactions']);
  });

  it('sends the consent list in update mode, without products', async () => {
    const calls: LinkTokenCreateRequest[] = [];
    const client = clientWithStub(
      {
        linkTokenCreate: async (req: LinkTokenCreateRequest) => {
          calls.push(req);
          return { data: { link_token: 'lt', hosted_link_url: 'https://h', request_id: 'r' } };
        },
      },
      [],
    );

    await client.createLinkToken({
      accessToken: 'access-sandbox-tok',
      additionalConsentedProducts: CONSENTED_PRODUCTS,
    });

    expect(calls[0]?.access_token).toBe('access-sandbox-tok');
    expect(calls[0]?.additional_consented_products).toEqual([...CONSENTED_PRODUCTS]);
    // Update mode must not resend products: the Item's product set and its
    // history depth are already fixed.
    expect(calls[0]?.products).toBeUndefined();
    expect(calls[0]?.transactions).toBeUndefined();
  });

  it('omits the field entirely when no consent list is given', async () => {
    const calls: LinkTokenCreateRequest[] = [];
    const client = clientWithStub(
      {
        linkTokenCreate: async (req: LinkTokenCreateRequest) => {
          calls.push(req);
          return { data: { link_token: 'lt', hosted_link_url: 'https://h', request_id: 'r' } };
        },
      },
      [],
    );

    await client.createLinkToken({});

    expect('additional_consented_products' in (calls[0] ?? {})).toBe(false);
  });
});

describe('getRecurringStreams', () => {
  it('returns the raw response', async () => {
    const client = clientWithStub(
      {
        transactionsRecurringGet: async () => ({
          data: {
            inflow_streams: [],
            outflow_streams: [],
            updated_datetime: '2026-08-18T00:00:00Z',
            request_id: 'r',
          } as TransactionsRecurringGetResponse,
        }),
      },
      [],
    );

    const result = await client.getRecurringStreams('access-tok');

    expect(result.updated_datetime).toBe('2026-08-18T00:00:00Z');
  });

  it('surfaces a consent failure as a classifiable error', async () => {
    const client = clientWithStub(
      {
        transactionsRecurringGet: async () => {
          throw wireError(400, {
            error_code: 'ADDITIONAL_CONSENT_REQUIRED',
            error_type: 'INVALID_INPUT',
            error_message: 'consent required',
          });
        },
      },
      [],
    );

    await expect(client.getRecurringStreams('access-tok')).rejects.toSatisfy(isConsentRequired);
  });
});

describe('refreshTransactions', () => {
  it('calls /transactions/refresh with the access token', async () => {
    const seen: Array<{ access_token: string }> = [];
    const client = clientWithStub(
      {
        transactionsRefresh: async (req: { access_token: string }) => {
          seen.push(req);
          return { data: { request_id: 'r' } as TransactionsRefreshResponse };
        },
      },
      [],
    );

    await client.refreshTransactions('access-tok');

    expect(seen).toEqual([{ access_token: 'access-tok' }]);
  });

  it('returns nothing — the endpoint yields no data, only a trigger', async () => {
    const client = clientWithStub(
      {
        transactionsRefresh: async () => ({
          data: { request_id: 'r' } as TransactionsRefreshResponse,
        }),
      },
      [],
    );

    await expect(client.refreshTransactions('access-tok')).resolves.toBeUndefined();
  });

  it('propagates a reauth failure so the caller can classify it', async () => {
    const client = clientWithStub(
      {
        transactionsRefresh: async () => {
          throw wireError(400, {
            error_code: 'ITEM_LOGIN_REQUIRED',
            error_type: 'ITEM_ERROR',
            error_message: 'login required',
          });
        },
      },
      [],
    );

    const error = await client.refreshTransactions('access-tok').catch((e: unknown) => e);
    expect(isReauthRequired(error)).toBe(true);
  });
});
