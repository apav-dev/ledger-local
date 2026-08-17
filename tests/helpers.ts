import {
  openDb,
  setAccountSynced,
  setItemCursor,
  upsertAccount,
  upsertItem,
  upsertTransactions,
  type Db,
  type TransactionRow,
} from '../src/core/db.js';

export const NOW = Date.UTC(2026, 7, 17); // 2026-08-17

/**
 * Amounts are integer cents following Plaid's convention: POSITIVE is money
 * leaving the account, NEGATIVE is income. t4 is the only inflow.
 */
export function seedDb(): Db {
  const db = openDb(':memory:');
  upsertItem(db, {
    id: 'item_1',
    access_token: 'access-sandbox-tok',
    institution: 'Chase',
    institution_id: 'ins_56',
    created_at: 1,
  });
  setItemCursor(db, 'item_1', 'cursor_1');
  upsertAccount(db, {
    id: 'acc_1', item_id: 'item_1', name: 'Checking', official_name: 'Total Checking',
    institution: 'Chase', type: 'depository', subtype: 'checking', mask: '1111',
    iso_currency_code: 'USD', available_balance_cents: 50_000, current_balance_cents: 50_000,
  });
  upsertAccount(db, {
    id: 'acc_2', item_id: 'item_1', name: 'Card', official_name: 'Freedom Card',
    institution: 'Chase', type: 'credit', subtype: 'credit card', mask: '2222',
    iso_currency_code: 'USD', available_balance_cents: -20_000, current_balance_cents: -20_000,
  });
  setAccountSynced(db, 'acc_1', NOW - 60_000); // 1 min ago
  setAccountSynced(db, 'acc_2', NOW - 60_000);

  const t = (id: string, over: Partial<TransactionRow>): TransactionRow => ({
    id, account_id: 'acc_1', date: '2026-08-10', description: 'X', amount_cents: 1000,
    category_primary: null, category_detailed: null, counterparty: null,
    status: 'posted', type: 'in store', pending_transaction_id: null, ...over,
  });

  upsertTransactions(db, [
    t('t1', { amount_cents: 5000, category_primary: 'GROCERIES', counterparty: 'Costco', date: '2026-08-01' }),
    t('t2', { amount_cents: 3000, category_primary: 'GROCERIES', counterparty: 'Safeway', date: '2026-08-05' }),
    t('t3', { amount_cents: 2000, category_primary: 'FOOD_AND_DRINK', counterparty: 'Blue Bottle', date: '2026-07-20' }),
    t('t4', { amount_cents: -200_000, category_primary: 'INCOME', counterparty: 'Employer', date: '2026-08-01' }),
    t('t5', { amount_cents: 9900, category_primary: 'FOOD_AND_DRINK', counterparty: 'Sushi', status: 'pending', date: '2026-08-15' }),
    t('t6', { amount_cents: 4000, category_primary: 'TRAVEL', counterparty: 'BART', account_id: 'acc_2', date: '2026-08-08' }),
  ]);
  return db;
}
