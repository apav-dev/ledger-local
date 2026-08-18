import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import type { LedgerConfig } from '../src/core/config.js';
import type { Db } from '../src/core/db.js';
import { PlaidApiError, type LedgerPlaidApi } from '../src/core/plaid-client.js';
import { buildMcpServer } from '../src/mcp/server.js';
import { seedDb } from './helpers.js';

const cfg: LedgerConfig = {
  clientId: 'cid_test',
  secret: 'sec_test',
  environment: 'sandbox',
  configDir: '/tmp/nope',
  dbPath: ':memory:',
};

const noApi: LedgerPlaidApi = {
  itemRemove: async () => {},
  getAccounts: async () => [],
  syncTransactions: async () => ({
    accounts: [],
    added: [],
    modified: [],
    removed: [],
    next_cursor: 'c',
    has_more: false,
  }) as never,
  createLinkToken: async () => ({ linkToken: 'l', hostedLinkUrl: null }),
  getLinkSession: async () => ({}) as never,
  exchangePublicToken: async () => ({ accessToken: 'a', itemId: 'i' }),
};

async function connect(api: LedgerPlaidApi = noApi, db: Db = seedDb()) {
  const server = buildMcpServer({ db, api, cfg });
  const client = new Client({ name: 'test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

/** Tool results arrive as a wide SDK union; narrow to the text payload. */
function rawText(result: unknown): string {
  const content = (result as { content?: Array<{ text?: string }> }).content;
  return content?.[0]?.text ?? '';
}

function textOf(result: unknown): unknown {
  return JSON.parse(rawText(result) || 'null');
}

describe('mcp server', () => {
  it('exposes the five tools', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name).sort()).toEqual([
      'auth_status',
      'list_accounts',
      'list_transactions',
      'spending_summary',
      'sync',
    ]);
  });

  it('list_accounts returns rows and staleness meta', async () => {
    const client = await connect();
    const result = await client.callTool({ name: 'list_accounts', arguments: {} });
    const data = textOf(result) as { accounts: unknown[]; meta: { stale: boolean } };
    expect(data.accounts).toHaveLength(2);
    expect(typeof data.meta.stale).toBe('boolean');
  });

  it('list_transactions applies filters', async () => {
    const client = await connect();
    const result = await client.callTool({
      name: 'list_transactions',
      arguments: { search: 'costco', limit: 5 },
    });
    const data = textOf(result) as { transactions: Array<{ id: string }> };
    expect(data.transactions.map(t => t.id)).toEqual(['t1']);
  });

  it('spending_summary groups by category with positive totals', async () => {
    const client = await connect();
    const result = await client.callTool({
      name: 'spending_summary',
      arguments: { from: '2026-07-01', to: '2026-08-31', groupBy: 'category' },
    });
    const data = textOf(result) as { grandTotal: number; groups: Array<{ total: number }> };
    expect(data.grandTotal).toBe(140);
    expect(data.groups.every(g => g.total > 0)).toBe(true);
  });

  it('auth_status reports item ids so a model can name the connection to repair', async () => {
    const client = await connect();
    const data = textOf(await client.callTool({ name: 'auth_status', arguments: {} })) as {
      environment: string;
      items: Array<{ id: string; institution: string; synced: boolean }>;
    };
    expect(data.environment).toBe('sandbox');
    expect(data.items).toEqual([
      { id: 'item_1', institution: 'Chase', accountCount: 2, synced: true },
    ]);
  });

  describe('sign-convention guardrails', () => {
    // Storing Plaid-native amounts makes this description the only thing
    // standing between a model and reporting income as spending.
    it('warns loudly and unambiguously on list_transactions', async () => {
      const client = await connect();
      const { tools } = await client.listTools();
      const description = tools.find(t => t.name === 'list_transactions')?.description ?? '';

      expect(description).toMatch(/POSITIVE amount means money LEFT/);
      expect(description).toMatch(/NEGATIVE amount means money ENTERED/);
      expect(description).toMatch(/OPPOSITE of a bank statement/);
      // Must actively counter the default assumption, not just state the rule.
      expect(description).toMatch(/Do not assume/);
      // And must point at the tool that removes the hazard.
      expect(description).toMatch(/spending_summary/);
    });

    it('tells the model that spending_summary needs no sign reasoning', async () => {
      const client = await connect();
      const { tools } = await client.listTools();
      const description = tools.find(t => t.name === 'spending_summary')?.description ?? '';
      expect(description).toMatch(/POSITIVE dollar amounts/);
    });

    it('returns income as negative so the description matches reality', async () => {
      const client = await connect();
      const data = textOf(
        await client.callTool({ name: 'list_transactions', arguments: { category: 'INCOME' } }),
      ) as { transactions: Array<{ amount: number }> };
      expect(data.transactions[0]?.amount).toBe(-2000);
    });
  });

  describe('money is dollars on the wire', () => {
    // Storage is integer cents. If a cents value ever reached a model it would
    // report a 100x figure — a worse error than the sign hazard above, and one
    // with no warning text to catch it. Every tool result must be dollars.
    it('emits dollar amounts, not cents', async () => {
      const client = await connect();
      const txns = textOf(
        await client.callTool({ name: 'list_transactions', arguments: { search: 'costco' } }),
      ) as { transactions: Array<{ amount: number }> };
      expect(txns.transactions[0]?.amount).toBe(50); // 5000 cents

      const accounts = textOf(await client.callTool({ name: 'list_accounts', arguments: {} })) as {
        accounts: Array<{ id: string; current_balance: number | null }>;
      };
      expect(accounts.accounts.find(a => a.id === 'acc_1')?.current_balance).toBe(500);
    });

    it('exposes no cent-denominated field on any tool', async () => {
      const client = await connect();
      const payloads = await Promise.all([
        client.callTool({ name: 'list_accounts', arguments: {} }),
        client.callTool({ name: 'list_transactions', arguments: {} }),
        client.callTool({
          name: 'spending_summary',
          arguments: { from: '2026-07-01', to: '2026-08-31', groupBy: 'category' },
        }),
      ]);
      for (const payload of payloads) {
        expect(rawText(payload)).not.toMatch(/cents/i);
      }
    });
  });

  describe('reauth guidance', () => {
    const reauthApi: LedgerPlaidApi = {
      ...noApi,
      getAccounts: async () => {
        throw new PlaidApiError('login required', 'ITEM_LOGIN_REQUIRED', 'ITEM_ERROR', 400);
      },
    };

    it('directs the model to auth repair, not auth', async () => {
      // Suggesting plain `auth` would create a duplicate Item and burn one of
      // the Trial plan's 10 slots.
      const client = await connect(reauthApi);
      const result = await client.callTool({ name: 'sync', arguments: {} });
      expect(result.isError).toBe(true);
      const text = rawText(result);
      expect(text).toContain('ledger auth repair');
      expect(text).toContain('ITEM_LOGIN_REQUIRED');
      expect(text).toMatch(/Do not suggest `ledger auth`/);
    });

    it('still returns the per-account results alongside the error', async () => {
      const client = await connect(reauthApi);
      const data = textOf(await client.callTool({ name: 'sync', arguments: {} })) as {
        error: string;
        results: Array<{ ok: boolean }>;
      };
      expect(data.results.some(r => !r.ok)).toBe(true);
    });
  });

  it('sync reports removed counts', async () => {
    const client = await connect();
    const data = textOf(await client.callTool({ name: 'sync', arguments: {} })) as {
      results: Array<{ removed: number }>;
    };
    expect(data.results.every(r => typeof r.removed === 'number')).toBe(true);
  });

  it('documents that accountId does not narrow what Plaid refreshes', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const description = tools.find(t => t.name === 'sync')?.description ?? '';
    expect(description).toMatch(/whole bank connection/);
  });
});
