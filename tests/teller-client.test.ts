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
