import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import type { TellerConfig } from '../src/core/config.js';
import { TellerApiError } from '../src/core/teller-client.js';
import type { TellerApi } from '../src/core/types.js';
import { buildMcpServer } from '../src/mcp/server.js';
import { seedDb } from './helpers.js';

const cfg: TellerConfig = {
  applicationId: 'app_test',
  environment: 'development',
  configDir: '/tmp/nope',
  certPath: '/tmp/nope/certificate.pem',
  keyPath: '/tmp/nope/private_key.pem',
  dbPath: ':memory:',
};

const noApi: TellerApi = {
  listAccounts: async () => [],
  getBalance: async () => ({ account_id: 'x', available: null, ledger: null }),
  listTransactions: async () => [],
};

async function connectedClient() {
  const server = buildMcpServer({ db: seedDb(), api: noApi, cfg });
  const client = new Client({ name: 'test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function textOf(result: { content?: unknown }): unknown {
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0]?.text ?? 'null');
}

describe('mcp server', () => {
  it('exposes the five tools', async () => {
    const client = await connectedClient();
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
    const client = await connectedClient();
    const result = await client.callTool({ name: 'list_accounts', arguments: {} });
    const data = textOf(result) as { accounts: unknown[]; meta: { stale: boolean } };
    expect(data.accounts).toHaveLength(2);
    expect(typeof data.meta.stale).toBe('boolean');
  });

  it('list_transactions validates and applies filters', async () => {
    const client = await connectedClient();
    const result = await client.callTool({
      name: 'list_transactions',
      arguments: { search: 'costco', limit: 5 },
    });
    const data = textOf(result) as { transactions: Array<{ id: string }> };
    expect(data.transactions.map(t => t.id)).toEqual(['t1']);
  });

  it('spending_summary groups by category', async () => {
    const client = await connectedClient();
    const result = await client.callTool({
      name: 'spending_summary',
      arguments: { from: '2026-06-01', to: '2026-07-31', groupBy: 'category' },
    });
    const data = textOf(result) as { grandTotal: number };
    expect(data.grandTotal).toBe(140);
  });

  it('sync surfaces a 401 as an error result mentioning teller auth', async () => {
    const reauthApi: TellerApi = {
      listAccounts: async () => {
        throw new TellerApiError('unauthorized', 401);
      },
      getBalance: async () => ({ account_id: 'x', available: null, ledger: null }),
      listTransactions: async () => [],
    };
    const server = buildMcpServer({ db: seedDb(), api: reauthApi, cfg });
    const client = new Client({ name: 'test', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const result = await client.callTool({ name: 'sync', arguments: {} });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toContain('teller auth');
  });
});
