import type { LinkTokenGetResponse, LinkTokenGetSessionsResponse } from 'plaid';
import { describe, expect, it } from 'vitest';
import {
  LinkError,
  linkNewItem,
  readTerminalSession,
  repairItem,
  upgradeConsent,
} from '../src/auth/link.js';
import {
  getItem,
  itemConsent,
  listItems,
  openDb,
  setItemCursor,
  upsertItem,
  type Db,
} from '../src/core/db.js';
import {
  CONSENTED_PRODUCTS,
  type CreateLinkTokenOpts,
  type LedgerPlaidApi,
} from '../src/core/plaid-client.js';

function session(over: Partial<LinkTokenGetSessionsResponse> = {}): LinkTokenGetSessionsResponse {
  return { link_session_id: 'sess_1', ...over } as LinkTokenGetSessionsResponse;
}

function successSession(institutionName: string | null = 'Chase'): LinkTokenGetSessionsResponse {
  return session({
    finished_at: '2026-08-17T00:00:00Z',
    results: {
      item_add_results: [
        {
          public_token: 'public-sandbox-abc',
          accounts: [],
          institution:
            institutionName === null ? null : { name: institutionName, institution_id: 'ins_56' },
        },
      ],
      cra_item_add_results: [],
      cra_update_results: [],
      bank_income_results: [],
      payroll_income_results: [],
      document_income_results: null,
    },
  } as Partial<LinkTokenGetSessionsResponse>);
}

/** Builds a complete `/link/token/get` response wrapping the given sessions. */
function linkResponse(sessions: LinkTokenGetSessionsResponse[]): LinkTokenGetResponse {
  return {
    link_token: 'link-sandbox-1',
    created_at: '2026-08-17T00:00:00Z',
    expiration: '2026-08-17T04:00:00Z',
    metadata: {} as LinkTokenGetResponse['metadata'],
    request_id: 'req_1',
    link_sessions: sessions,
  };
}

/** Returns one `/link/token/get` response per poll, in order. */
function fakeApi(
  responses: LinkTokenGetResponse[],
  over: Partial<LedgerPlaidApi> = {},
): LedgerPlaidApi & { linkTokenRequests: Array<{ accessToken?: string | undefined }> } {
  let i = 0;
  const linkTokenRequests: Array<{ accessToken?: string | undefined }> = [];
  const api = {
    linkTokenRequests,
    getAccounts: over.getAccounts ?? (async () => []),
    syncTransactions: over.syncTransactions ?? (async () => ({}) as never),
    createLinkToken:
      over.createLinkToken ??
      (async opts => {
        linkTokenRequests.push({ accessToken: opts.accessToken });
        return { linkToken: 'link-sandbox-1', hostedLinkUrl: 'https://secure.plaid.com/link/xyz' };
      }),
    getLinkSession:
      over.getLinkSession ??
      (async () => {
        const next = responses[i] ?? responses[responses.length - 1];
        i += 1;
        return next ?? linkResponse([]);
      }),
    exchangePublicToken:
      over.exchangePublicToken ??
      (async () => ({ accessToken: 'access-sandbox-tok', itemId: 'item_1' })),
    getRecurringStreams: over.getRecurringStreams ?? (async () => {
      throw new Error('unexpected call');
    }),
    getLiabilities: over.getLiabilities ?? (async () => {
      throw new Error('unexpected call');
    }),
    refreshTransactions: over.refreshTransactions ?? (async () => {
      throw new Error('unexpected call');
    }),
    itemRemove: over.itemRemove ?? (async () => {
      throw new Error('unexpected call');
    }),
  };
  return api as LedgerPlaidApi & {
    linkTokenRequests: Array<{ accessToken?: string | undefined }>;
  };
}

const RUN = {
  openUrl: () => {},
  pollIntervalMs: 1,
  timeoutMs: 50,
  sleep: async () => {},
};

function dbWithItem(): Db {
  const db = openDb(':memory:', 'sandbox');
  upsertItem(db, {
    id: 'item_1',
    access_token: 'access-sandbox-old',
    institution: 'Chase',
    institution_id: 'ins_56',
    created_at: 1,
    consented_products: null,
  });
  return db;
}

describe('readTerminalSession', () => {
  it('returns null while the session is still in flight', () => {
    expect(readTerminalSession(session())).toBeNull();
    expect(readTerminalSession(session({ started_at: '2026-08-17T00:00:00Z' }))).toBeNull();
  });

  it('extracts the public token and institution from item_add_results', () => {
    const terminal = readTerminalSession(successSession());
    expect(terminal).toMatchObject({
      publicToken: 'public-sandbox-abc',
      institutionName: 'Chase',
      institutionId: 'ins_56',
    });
  });

  it('prefers success evidence over a finished_at that also marks cancellation', () => {
    // A cancelled session carries finished_at too, so checking finished_at
    // first would misread a successful link as a no-op.
    const terminal = readTerminalSession(successSession());
    expect(terminal?.publicToken).toBe('public-sandbox-abc');
  });

  it('throws a readable error when the user closed Link', () => {
    expect(() =>
      readTerminalSession(
        session({ finished_at: '2026-08-17T00:00:00Z', exit: { error: null, metadata: null } }),
      ),
    ).toThrow(/closed before a bank was linked/);
  });

  it('surfaces the Plaid error code when Link exits with one', () => {
    expect(() =>
      readTerminalSession(
        session({
          exit: {
            error: {
              error_type: 'ITEM_ERROR' as never,
              error_code: 'INVALID_CREDENTIALS',
              error_message: 'the credentials were not correct',
              display_message: null,
            },
            metadata: null,
          },
        }),
      ),
    ).toThrow(/INVALID_CREDENTIALS/);
  });

  it('treats a finished session with no token as terminal, which is update mode', () => {
    const terminal = readTerminalSession(session({ finished_at: '2026-08-17T00:00:00Z' }));
    expect(terminal).not.toBeNull();
    expect(terminal?.publicToken).toBeNull();
  });
});

describe('linkNewItem', () => {
  it('exchanges the public token and records the item with a NULL cursor', async () => {
    const db = openDb(':memory:', 'sandbox');
    const api = fakeApi([linkResponse([successSession()])]);
    const result = await linkNewItem(db, api, RUN);

    expect(result).toEqual({ itemId: 'item_1', institution: 'Chase' });
    const item = getItem(db, 'item_1');
    expect(item?.access_token).toBe('access-sandbox-tok');
    expect(item?.institution_id).toBe('ins_56');
    // NULL cursor is what makes the first sync a full backfill.
    expect(item?.cursor).toBeNull();
  });

  it('polls until the session reaches a terminal state', async () => {
    const db = openDb(':memory:', 'sandbox');
    const api = fakeApi([
      linkResponse([]),
      linkResponse([session({ started_at: 'x' })]),
      linkResponse([successSession()]),
    ]);
    await linkNewItem(db, api, RUN);
    expect(listItems(db)).toHaveLength(1);
  });

  it('requests a products-based link token, not update mode', async () => {
    const db = openDb(':memory:', 'sandbox');
    const api = fakeApi([linkResponse([successSession()])]);
    await linkNewItem(db, api, RUN);
    expect(api.linkTokenRequests).toEqual([{ accessToken: undefined }]);
  });

  it('falls back to a placeholder when Plaid omits the institution name', async () => {
    const db = openDb(':memory:', 'sandbox');
    const api = fakeApi([linkResponse([successSession(null)])]);
    const result = await linkNewItem(db, api, RUN);
    expect(result.institution).toBe('Unknown institution');
  });

  it('fails clearly when Hosted Link is not enabled', async () => {
    const db = openDb(':memory:', 'sandbox');
    const api = fakeApi([], {
      createLinkToken: async () => ({ linkToken: 'l', hostedLinkUrl: null }),
    });
    await expect(linkNewItem(db, api, RUN)).rejects.toThrow(/Hosted Link is enabled/);
  });

  it('times out rather than polling forever', async () => {
    const db = openDb(':memory:', 'sandbox');
    let polls = 0;
    const api = fakeApi([], {
      getLinkSession: async () => {
        polls += 1;
        return linkResponse([]);
      },
    });
    await expect(
      linkNewItem(db, api, { ...RUN, pollIntervalMs: 10, timeoutMs: 50 }),
    ).rejects.toThrow(/timed out/);
    // Bounded by ceil(timeout / interval); never unbounded.
    expect(polls).toBeLessThanOrEqual(5);
    expect(listItems(db)).toHaveLength(0);
  });

  it('records nothing when the user cancels', async () => {
    const db = openDb(':memory:', 'sandbox');
    const api = fakeApi([
      linkResponse([session({ finished_at: 'x', exit: { error: null, metadata: null } })]),
    ]);
    await expect(linkNewItem(db, api, RUN)).rejects.toThrow(LinkError);
    expect(listItems(db)).toHaveLength(0);
  });

  it('does not record an item when the exchange fails', async () => {
    const db = openDb(':memory:', 'sandbox');
    const api = fakeApi([linkResponse([successSession()])], {
      exchangePublicToken: async () => {
        throw new Error('exchange rejected');
      },
    });
    await expect(linkNewItem(db, api, RUN)).rejects.toThrow(/exchange rejected/);
    expect(listItems(db)).toHaveLength(0);
  });

  it('opens the hosted url it was handed', async () => {
    const db = openDb(':memory:', 'sandbox');
    const opened: string[] = [];
    const api = fakeApi([linkResponse([successSession()])]);
    await linkNewItem(db, api, { ...RUN, openUrl: url => opened.push(url) });
    expect(opened).toEqual(['https://secure.plaid.com/link/xyz']);
  });
});

describe('repairItem', () => {
  it('sends the existing access token so update mode reuses the Item', async () => {
    const db = dbWithItem();
    const api = fakeApi([linkResponse([session({ finished_at: 'x' })])]);
    const result = await repairItem(db, api, 'item_1', RUN);

    expect(result).toEqual({ itemId: 'item_1', institution: 'Chase' });
    expect(api.linkTokenRequests).toEqual([{ accessToken: 'access-sandbox-old' }]);
  });

  it('does not create a second Item', async () => {
    // The whole point of update mode: a plain re-link would burn another of the
    // Trial plan's 10 Item slots and orphan the broken Item.
    const db = dbWithItem();
    const api = fakeApi([linkResponse([session({ finished_at: 'x' })])]);
    await repairItem(db, api, 'item_1', RUN);
    expect(listItems(db)).toHaveLength(1);
  });

  it('preserves the sync cursor so repair does not force a full re-download', async () => {
    const db = dbWithItem();
    setItemCursor(db, 'item_1', 'cursor_keep');
    const api = fakeApi([linkResponse([session({ finished_at: 'x' })])]);
    await repairItem(db, api, 'item_1', RUN);
    expect(getItem(db, 'item_1')?.cursor).toBe('cursor_keep');
  });

  it('rejects an unknown item id with an actionable message', async () => {
    const db = dbWithItem();
    const api = fakeApi([]);
    await expect(repairItem(db, api, 'item_absent', RUN)).rejects.toThrow(/auth status/);
  });

  it('propagates a cancelled repair session', async () => {
    const db = dbWithItem();
    const api = fakeApi([
      linkResponse([session({ finished_at: 'x', exit: { error: null, metadata: null } })]),
    ]);
    await expect(repairItem(db, api, 'item_1', RUN)).rejects.toThrow(LinkError);
  });
});

describe('consent', () => {
  it('requests the consent set when linking a new item, and records it', async () => {
    const db = openDb(':memory:', 'sandbox');
    const seen: CreateLinkTokenOpts[] = [];
    const api = fakeApi([linkResponse([successSession()])], {
      createLinkToken: async opts => {
        seen.push(opts);
        return { linkToken: 'lt', hostedLinkUrl: 'https://hosted' };
      },
    });

    await linkNewItem(db, api, RUN);

    expect(seen[0]?.additionalConsentedProducts).toEqual([...CONSENTED_PRODUCTS]);
    // Default stub exchanges into item_1 (not item_new).
    expect(itemConsent(db, 'item_1')).toEqual([...CONSENTED_PRODUCTS]);
  });

  it('upgrades consent on an existing item through update mode', async () => {
    const db = openDb(':memory:', 'sandbox');
    upsertItem(db, {
      id: 'item_1', access_token: 'access-tok', institution: 'Chase',
      institution_id: 'ins_56', created_at: 1, consented_products: null,
    });
    setItemCursor(db, 'item_1', 'cursor_keep');
    const seen: CreateLinkTokenOpts[] = [];
    const api = fakeApi([linkResponse([session({ finished_at: '2026-08-18T00:00:00Z' })])], {
      createLinkToken: async opts => {
        seen.push(opts);
        return { linkToken: 'lt', hostedLinkUrl: 'https://hosted' };
      },
    });

    const result = await upgradeConsent(db, api, 'item_1', RUN);

    expect(seen[0]?.accessToken).toBe('access-tok');
    expect(seen[0]?.additionalConsentedProducts).toEqual([...CONSENTED_PRODUCTS]);
    expect(result.consented).toEqual([...CONSENTED_PRODUCTS]);
    expect(itemConsent(db, 'item_1')).toEqual([...CONSENTED_PRODUCTS]);
    // Update mode must not disturb sync progress.
    expect(getItem(db, 'item_1')?.cursor).toBe('cursor_keep');
  });

  it('refuses to upgrade consent for an unknown item', async () => {
    const db = openDb(':memory:', 'sandbox');

    await expect(
      upgradeConsent(db, fakeApi([]), 'nope', RUN),
    ).rejects.toThrow(/No linked item with id "nope"/);
  });

  it('leaves consent unrecorded when the link session fails', async () => {
    const db = openDb(':memory:', 'sandbox');
    upsertItem(db, {
      id: 'item_1', access_token: 'access-tok', institution: 'Chase',
      institution_id: 'ins_56', created_at: 1, consented_products: null,
    });
    const api = fakeApi([
      linkResponse([
        session({
          exit: {
            error: {
              error_type: 'USER_ERROR' as never,
              error_code: 'USER_EXIT',
              error_message: 'closed',
              display_message: null,
            },
            metadata: null,
          },
        }),
      ]),
    ]);

    await expect(upgradeConsent(db, api, 'item_1', RUN)).rejects.toThrow(LinkError);
    expect(itemConsent(db, 'item_1')).toEqual([]);
  });
});
