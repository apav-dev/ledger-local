import { getItem, removeItem, type Db } from './db.js';
import { isItemNotFound } from './plaid-client.js';

export class ItemError extends Error {
  override readonly name = 'ItemError';
}

/** The slice of the Plaid client removal needs. Narrow so tests inject two lines. */
export interface ItemRemoveApi {
  itemRemove(accessToken: string): Promise<void>;
}

export interface RemovedItem {
  itemId: string;
  institution: string;
  accounts: number;
  transactions: number;
  /** True when Plaid had already lost the Item, so only local cleanup happened. */
  alreadyGoneAtPlaid: boolean;
}

/**
 * Removes an Item at Plaid, then deletes its local rows.
 *
 * The order is the whole point. The access token is the only way to remove an
 * Item, and it lives in the row being deleted — so deleting locally first would
 * strand the Item at Plaid, where it keeps occupying one of the account's Item
 * slots with no way left to reach it. If Plaid refuses, local data stays put and
 * the operation can be retried.
 *
 * ITEM_NOT_FOUND is the exception: the Item is already gone upstream, so
 * refusing to clean up would leave a permanently unsyncable row behind.
 */
export async function removeLinkedItem(
  db: Db,
  api: ItemRemoveApi,
  itemId: string,
): Promise<RemovedItem> {
  const item = getItem(db, itemId);
  if (item === undefined) {
    throw new ItemError(
      `No linked item with id "${itemId}". Run \`ledger auth status\` to list them.`,
    );
  }

  let alreadyGoneAtPlaid = false;
  try {
    await api.itemRemove(item.access_token);
  } catch (error) {
    if (!isItemNotFound(error)) throw error;
    alreadyGoneAtPlaid = true;
  }

  const counts = removeItem(db, itemId);
  return {
    itemId,
    institution: item.institution,
    accounts: counts.accounts,
    transactions: counts.transactions,
    alreadyGoneAtPlaid,
  };
}
