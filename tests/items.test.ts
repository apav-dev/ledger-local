import { describe, expect, it } from 'vitest';
import {
  countTransactions,
  getItem,
  listAccountRows,
  listItems,
  openDb,
  removeItem,
  upsertAccount,
  upsertItem,
  upsertTransactions,
  type AccountUpsert,
  type Db,
} from '../src/core/db.js';
import { PlaidApiError } from '../src/core/plaid-client.js';
import { ItemError, removeLinkedItem } from '../src/core/items.js';
import { fullTransactionRow } from './helpers.js';

function account(id: string, itemId: string): AccountUpsert {
  return {
    id,
    item_id: itemId,
    name: `Account ${id}`,
    official_name: null,
    institution: 'Chase',
    type: 'depository',
    subtype: 'checking',
    mask: '1111',
    iso_currency_code: 'USD',
    available_balance_cents: 1000,
    current_balance_cents: 1000,
  };
}

/** Two Items so every test can prove the untouched one survives. */
function seed(): Db {
  const db = openDb(':memory:', 'sandbox');
  upsertItem(db, {
    id: 'item_1',
    access_token: 'access-sandbox-one',
    institution: 'Chase',
    institution_id: 'ins_1',
    created_at: 1,
  });
  upsertItem(db, {
    id: 'item_2',
    access_token: 'access-sandbox-two',
    institution: 'Ally',
    institution_id: 'ins_2',
    created_at: 2,
  });
  upsertAccount(db, account('acc_1a', 'item_1'));
  upsertAccount(db, account('acc_1b', 'item_1'));
  upsertAccount(db, account('acc_2a', 'item_2'));
  upsertTransactions(db, [
    fullTransactionRow({ id: 't1', account_id: 'acc_1a' }),
    fullTransactionRow({ id: 't2', account_id: 'acc_1a' }),
    fullTransactionRow({ id: 't3', account_id: 'acc_1b' }),
    fullTransactionRow({ id: 't4', account_id: 'acc_2a' }),
  ]);
  return db;
}

describe('removeItem', () => {
  it('deletes the item, its accounts, and their transactions', () => {
    const db = seed();
    const counts = removeItem(db, 'item_1');

    expect(counts).toEqual({ accounts: 2, transactions: 3 });
    expect(getItem(db, 'item_1')).toBeUndefined();
    expect(listAccountRows(db).map(a => a.id)).toEqual(['acc_2a']);
  });

  it('leaves other items completely intact', () => {
    const db = seed();
    removeItem(db, 'item_1');

    expect(listItems(db).map(i => i.id)).toEqual(['item_2']);
    expect(countTransactions(db, 'acc_2a')).toBe(1);
  });

  it('is a no-op for an unknown item', () => {
    const db = seed();
    expect(removeItem(db, 'item_missing')).toEqual({ accounts: 0, transactions: 0 });
    expect(listItems(db)).toHaveLength(2);
  });

  it('does not violate foreign keys while cascading', () => {
    // Transactions reference accounts, which reference items. Deleting in the
    // wrong order aborts on the foreign key with rows already gone.
    const db = seed();
    expect(() => removeItem(db, 'item_1')).not.toThrow();
  });
});

interface FakeApi {
  itemRemove: (accessToken: string) => Promise<void>;
  removed: string[];
}

function fakeApi(behavior?: (token: string) => Promise<void>): FakeApi {
  const removed: string[] = [];
  return {
    removed,
    itemRemove: async (accessToken: string) => {
      removed.push(accessToken);
      if (behavior) await behavior(accessToken);
    },
  };
}

describe('removeLinkedItem', () => {
  it('removes at Plaid before deleting locally', async () => {
    const db = seed();
    const api = fakeApi();

    const result = await removeLinkedItem(db, api, 'item_1');

    expect(api.removed).toEqual(['access-sandbox-one']);
    expect(result).toMatchObject({ institution: 'Chase', accounts: 2, transactions: 3 });
    expect(getItem(db, 'item_1')).toBeUndefined();
  });

  it('keeps local data when Plaid refuses the removal', async () => {
    // Deleting locally first would discard the access token, leaving an Item
    // stranded at Plaid that still occupies a slot and can no longer be removed.
    const db = seed();
    const api = fakeApi(() => {
      throw new PlaidApiError('nope', 'INTERNAL_SERVER_ERROR', 'API_ERROR', 500);
    });

    await expect(removeLinkedItem(db, api, 'item_1')).rejects.toThrow(/nope/);
    expect(getItem(db, 'item_1')).toBeDefined();
    expect(countTransactions(db, 'acc_1a')).toBe(2);
  });

  it('still cleans up locally when Plaid has already lost the Item', async () => {
    // Nothing to strand: the Item is gone upstream, so refusing to clean up
    // would leave a permanently unsyncable row behind.
    const db = seed();
    const api = fakeApi(() => {
      throw new PlaidApiError('gone', 'ITEM_NOT_FOUND', 'ITEM_ERROR', 400);
    });

    const result = await removeLinkedItem(db, api, 'item_1');
    expect(result.accounts).toBe(2);
    expect(getItem(db, 'item_1')).toBeUndefined();
  });

  it('rejects an unknown item without calling Plaid', async () => {
    const db = seed();
    const api = fakeApi();
    await expect(removeLinkedItem(db, api, 'item_missing')).rejects.toThrow(ItemError);
    expect(api.removed).toEqual([]);
  });

  it('never puts the access token in the error message', async () => {
    const db = seed();
    const api = fakeApi(() => {
      throw new PlaidApiError('boom', 'INTERNAL_SERVER_ERROR', 'API_ERROR', 500);
    });
    try {
      await removeLinkedItem(db, api, 'item_1');
      expect.unreachable('removeLinkedItem should have thrown');
    } catch (error) {
      expect((error as Error).message).not.toContain('access-sandbox-one');
    }
  });
});
