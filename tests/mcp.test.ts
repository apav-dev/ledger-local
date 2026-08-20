import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import type { LedgerConfig } from '../src/core/config.js';
import type { Db } from '../src/core/db.js';
import { replaceLiabilities, replaceRecurringStreams } from '../src/core/db.js';
import { PlaidApiError, type LedgerPlaidApi } from '../src/core/plaid-client.js';
import { buildMcpServer } from '../src/mcp/server.js';
import { NOW, addLoanAccount, seedDb } from './helpers.js';

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
  syncTransactions: async () =>
    ({
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
  getRecurringStreams: async () => {
    throw new Error('unexpected call');
  },
  getLiabilities: async () => {
    throw new Error('unexpected call');
  },
  refreshTransactions: async () => {
    throw new Error('unexpected call');
  },
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
  it('exposes the ten tools', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name).sort()).toEqual([
      'auth_status',
      'list_accounts',
      'list_categories',
      'list_liabilities',
      'list_recurring',
      'list_transactions',
      'refresh_liabilities',
      'refresh_recurring',
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

  it('tells the model that a positive loan or credit balance is money owed', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const description = tools.find(t => t.name === 'list_accounts')?.description ?? '';
    expect(description).toMatch(/OWED/i);
    expect(description).toMatch(/subtract/i);
    expect(description).toMatch(/never add/i);
  });

  it('list_transactions applies filters', async () => {
    const client = await connect();
    const result = await client.callTool({
      name: 'list_transactions',
      arguments: { search: 'amazon', limit: 5 },
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
      {
        id: 'item_1',
        institution: 'Chase',
        accountCount: 2,
        synced: true,
        consented: [],
        consentUpToDate: false,
      },
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
        await client.callTool({ name: 'list_transactions', arguments: { search: 'amazon' } }),
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

  describe('sync force', () => {
    it('does not refresh by default', async () => {
      let refreshes = 0;
      const api: LedgerPlaidApi = {
        ...noApi,
        refreshTransactions: async () => {
          refreshes += 1;
        },
        getAccounts: async () => [],
        syncTransactions: async () =>
          ({
            accounts: [],
            added: [],
            modified: [],
            removed: [],
            next_cursor: 'c',
            has_more: false,
          }) as never,
      };
      const client = await connect(api);
      await client.callTool({ name: 'sync', arguments: {} });
      expect(refreshes).toBe(0);
    });

    it('refreshes when force is true', async () => {
      let refreshes = 0;
      const api: LedgerPlaidApi = {
        ...noApi,
        refreshTransactions: async () => {
          refreshes += 1;
        },
        getAccounts: async () => [],
        syncTransactions: async () =>
          ({
            accounts: [],
            added: [],
            modified: [],
            removed: [],
            next_cursor: 'c',
            has_more: false,
          }) as never,
      };
      const client = await connect(api);
      await client.callTool({ name: 'sync', arguments: { force: true } });
      expect(refreshes).toBe(1);
    });
  });

  describe('list_categories', () => {
    it('returns known categories with counts', async () => {
      const client = await connect();
      const data = textOf(await client.callTool({ name: 'list_categories', arguments: {} })) as {
        categories: Array<{ category: string; count: number }>;
        meta: { stale: boolean };
      };
      expect(data.categories.map(c => c.category).sort()).toEqual([
        'FOOD_AND_DRINK',
        'GROCERIES',
        'INCOME',
        'TRAVEL',
      ]);
      expect(data.categories.find(c => c.category === 'GROCERIES')?.count).toBe(2);
    });
  });

  describe('date and category validation', () => {
    it('rejects a garbage date on list_transactions instead of returning empty', async () => {
      const client = await connect();
      const result = await client.callTool({
        name: 'list_transactions',
        arguments: { from: '2026-13-45' },
      });
      expect(result.isError).toBe(true);
      expect(rawText(result)).toMatch(/not a valid date/);
    });

    it('rejects a garbage date on spending_summary instead of returning a zero total', async () => {
      const client = await connect();
      const result = await client.callTool({
        name: 'spending_summary',
        arguments: { from: 'last month', to: 'today', groupBy: 'category' },
      });
      expect(result.isError).toBe(true);
      expect(rawText(result)).toMatch(/not a valid date/);
    });

    it('rejects an inverted date range', async () => {
      const client = await connect();
      const result = await client.callTool({
        name: 'spending_summary',
        arguments: { from: '2026-08-31', to: '2026-08-01', groupBy: 'category' },
      });
      expect(result.isError).toBe(true);
      expect(rawText(result)).toMatch(/must not be after/);
    });

    it('resolves a relative date keyword end-to-end', async () => {
      const client = await connect();
      const result = await client.callTool({
        name: 'spending_summary',
        arguments: { from: 'this-month', to: 'today', groupBy: 'category' },
      });
      expect(result.isError).toBeUndefined();
    });

    it('matches category case-insensitively', async () => {
      const client = await connect();
      const result = await client.callTool({
        name: 'list_transactions',
        arguments: { category: 'groceries' },
      });
      const data = textOf(result) as { transactions: Array<{ id: string }> };
      expect(data.transactions.map(t => t.id).sort()).toEqual(['t1', 't2']);
    });

    it('rejects an unknown category, listing the real ones', async () => {
      const client = await connect();
      const result = await client.callTool({
        name: 'list_transactions',
        arguments: { category: 'not_a_real_category' },
      });
      expect(result.isError).toBe(true);
      const text = rawText(result);
      expect(text).toMatch(/is not known/);
      expect(text).toContain('GROCERIES');
    });
  });

  describe('list_recurring', () => {
    it('returns stored streams as dollars with a real boolean flag', async () => {
      const db = seedDb();
      replaceRecurringStreams(db, 'item_1', [
        {
          stream_id: 's1', item_id: 'item_1', account_id: 'acc_1', direction: 'outflow',
          description: 'NETFLIX', merchant_name: 'Netflix',
          category_primary: 'ENTERTAINMENT', category_detailed: 'ENTERTAINMENT_STREAMING',
          frequency: 'MONTHLY', status: 'MATURE', is_active: 1,
          first_date: '2026-01-15', last_date: '2026-08-15',
          predicted_next_date: '2026-09-15',
          average_amount_cents: 1599, last_amount_cents: 1599,
          transaction_count: 8, refreshed_at: NOW,
        },
      ]);

      const client = await connect(noApi, db);
      const result = textOf(await client.callTool({ name: 'list_recurring', arguments: {} })) as {
        streams: Array<{ average_amount: number; is_active: boolean }>;
      };

      expect(result.streams[0]?.average_amount).toBe(15.99);
      expect(result.streams[0]?.is_active).toBe(true);
      expect(result.streams[0]).not.toHaveProperty('average_amount_cents');
    });

    it('honours the activeOnly filter', async () => {
      const db = seedDb();
      replaceRecurringStreams(db, 'item_1', [
        {
          stream_id: 's_dead', item_id: 'item_1', account_id: 'acc_1', direction: 'outflow',
          description: 'OLD GYM', merchant_name: 'Gym',
          category_primary: null, category_detailed: null,
          frequency: 'MONTHLY', status: 'TOMBSTONED', is_active: 0,
          first_date: '2025-01-01', last_date: '2026-02-01',
          predicted_next_date: null,
          average_amount_cents: 4000, last_amount_cents: 4000,
          transaction_count: 13, refreshed_at: NOW,
        },
      ]);

      const client = await connect(noApi, db);
      const result = textOf(
        await client.callTool({ name: 'list_recurring', arguments: { activeOnly: true } }),
      ) as { streams: unknown[] };

      expect(result.streams).toEqual([]);
    });
  });

  describe('list_liabilities', () => {
    it('returns 6.125 as a percentage and joined outstanding principal as dollars', async () => {
      const db = seedDb();
      addLoanAccount(db, 'acc_loan');
      replaceLiabilities(
        db,
        'item_1',
        {
          mortgage: [
            {
              account_id: 'acc_loan',
              item_id: 'item_1',
              refreshed_at: NOW,
              interest_rate_percentage: 6.125,
              interest_rate_type: 'fixed',
              escrow_balance_cents: 250_000,
              current_late_fee_cents: null,
              has_pmi: 0,
              has_prepayment_penalty: null,
              last_payment_amount_cents: null,
              last_payment_date: null,
              loan_type_description: null,
              loan_term: '30 year',
              maturity_date: '2054-05-01',
              next_monthly_payment_cents: 210_000,
              next_payment_due_date: '2026-09-01',
              origination_date: null,
              origination_principal_amount_cents: 40_000_000,
              past_due_amount_cents: null,
              property_street: null,
              property_city: null,
              property_region: null,
              property_postal_code: null,
              property_country: null,
              ytd_interest_paid_cents: null,
              ytd_principal_paid_cents: null,
            },
          ],
          credit: [],
          aprs: [],
        },
        NOW,
      );

      const client = await connect(noApi, db);
      const result = textOf(await client.callTool({ name: 'list_liabilities', arguments: {} })) as {
        mortgages: Array<{
          interest_rate_percentage: number;
          outstanding_principal: number;
          escrow_balance: number;
          has_pmi: boolean | null;
          has_prepayment_penalty: boolean | null;
        }>;
      };

      expect(result.mortgages[0]?.interest_rate_percentage).toBe(6.125);
      expect(result.mortgages[0]?.outstanding_principal).toBe(300_000);
      expect(result.mortgages[0]?.escrow_balance).toBe(2500);
      expect(result.mortgages[0]?.has_pmi).toBe(false);
      expect(result.mortgages[0]?.has_prepayment_penalty).toBeNull();
      expect(result.mortgages[0]).not.toHaveProperty('escrow_balance_cents');
    });

    it('documents that percentages are percentages and principal is joined', async () => {
      const client = await connect();
      const { tools } = await client.listTools();
      const description = tools.find(t => t.name === 'list_liabilities')?.description ?? '';
      expect(description).toMatch(/6\.125 means 6\.125%/);
      expect(description).toMatch(/JOINED/i);
      expect(description).toMatch(/never derive/i);
      expect(description).toMatch(/escrow_balance is a balance held/i);
      expect(description).toMatch(/cannot be forced/);
    });
  });
});
