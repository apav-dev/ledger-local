import {
  openDb,
  setAccountSynced,
  setItemCursor,
  upsertAccount,
  upsertItem,
  upsertTransactions,
  type AccountUpsert,
  type Db,
  type TransactionRow,
} from '../src/core/db.js';

export const NOW = Date.UTC(2026, 7, 17); // 2026-08-17

/** A TransactionRow with every field non-null. Shared by db and views tests. */
export function fullTransactionRow(over: Partial<TransactionRow> = {}): TransactionRow {
  return {
    id: 't1', account_id: 'acc_1', date: '2026-08-01', description: 'COFFEE',
    amount_cents: 450, category_primary: 'FOOD_AND_DRINK',
    category_detailed: 'FOOD_AND_DRINK_COFFEE', counterparty: 'Blue Bottle',
    status: 'posted', pending_transaction_id: 'pend_1',
    authorized_date: '2026-07-31', authorized_datetime: '2026-07-31T18:04:00Z',
    datetime: '2026-08-01T02:11:00Z',
    original_description: 'SQ *BLUE BOTTLE 4411',
    iso_currency_code: 'USD', unofficial_currency_code: 'BTC',
    category_confidence: 'VERY_HIGH',
    category_icon_url: 'https://plaid-category-icons.plaid.com/FOOD_AND_DRINK.png',
    merchant_entity_id: 'ent_bb',
    website: 'bluebottlecoffee.com',
    logo_url: 'https://plaid-merchant-logos.plaid.com/blue_bottle.png',
    counterparty_type: 'merchant',
    counterparties_json: '[{"name":"Blue Bottle","type":"merchant"}]',
    payment_channel: 'in store', transaction_code: 'purchase',
    check_number: '1234', account_owner: 'AARON PAVLICK',
    location_address: '300 Webster St', location_city: 'Oakland',
    location_region: 'CA', location_postal_code: '94607',
    location_country: 'US', location_lat: 37.8, location_lon: -122.27,
    location_store_number: '4411',
    payment_meta_reference_number: 'REF1', payment_meta_ppd_id: 'PPD1',
    payment_meta_payee: 'Payee', payment_meta_by_order_of: 'Order',
    payment_meta_payer: 'Payer', payment_meta_payment_method: 'ACH',
    payment_meta_payment_processor: 'Stripe', payment_meta_reason: 'Reason',
    ...over,
  };
}

/**
 * Amounts are integer cents following Plaid's convention: POSITIVE is money
 * leaving the account, NEGATIVE is income. t4 is the only inflow.
 */
export function seedDb(): Db {
  const db = openDb(':memory:', 'sandbox');
  upsertItem(db, {
    id: 'item_1',
    access_token: 'access-sandbox-tok',
    institution: 'Chase',
    institution_id: 'ins_56',
    created_at: 1,
    consented_products: null,
  });
  setItemCursor(db, 'item_1', 'cursor_1');
  upsertAccount(db, {
    id: 'acc_1', item_id: 'item_1', name: 'Checking', official_name: 'Total Checking',
    institution: 'Chase', type: 'depository', subtype: 'checking', mask: '1111',
    iso_currency_code: 'USD', available_balance_cents: 50_000, current_balance_cents: 50_000,
    limit_cents: null,
  });
  upsertAccount(db, {
    id: 'acc_2', item_id: 'item_1', name: 'Card', official_name: 'Freedom Card',
    institution: 'Chase', type: 'credit', subtype: 'credit card', mask: '2222',
    iso_currency_code: 'USD', available_balance_cents: -20_000, current_balance_cents: -20_000,
    limit_cents: null,
  });
  setAccountSynced(db, 'acc_1', NOW - 60_000); // 1 min ago
  setAccountSynced(db, 'acc_2', NOW - 60_000);

  // Only the fields a test asserts on carry values; the other 30 are null. This
  // is the inverse of `fullTransactionRow`, which is all-non-null so it can
  // catch a column dropped from the upsert.
  const t = (id: string, over: Partial<TransactionRow>): TransactionRow => ({
    id, account_id: 'acc_1', date: '2026-08-10', description: 'X', amount_cents: 1000,
    category_primary: null, category_detailed: null, counterparty: null,
    status: 'posted', pending_transaction_id: null,
    authorized_date: null, authorized_datetime: null, datetime: null,
    original_description: null,
    iso_currency_code: 'USD', unofficial_currency_code: null,
    category_confidence: null, category_icon_url: null,
    merchant_entity_id: null,
    website: null, logo_url: null,
    counterparty_type: null, counterparties_json: null,
    payment_channel: 'in store', transaction_code: null,
    check_number: null, account_owner: null,
    location_address: null, location_city: null, location_region: null,
    location_postal_code: null, location_country: null,
    location_lat: null, location_lon: null, location_store_number: null,
    payment_meta_reference_number: null, payment_meta_ppd_id: null,
    payment_meta_payee: null, payment_meta_by_order_of: null,
    payment_meta_payer: null, payment_meta_payment_method: null,
    payment_meta_payment_processor: null, payment_meta_reason: null,
    ...over,
  });

  upsertTransactions(db, [
    // t1 and t2 share a merchant entity under two different display names. This
    // is the case merchant grouping has to collapse.
    t('t1', { amount_cents: 5000, category_primary: 'GROCERIES', counterparty: 'Amazon',
              merchant_entity_id: 'ent_amazon', date: '2026-08-01',
              original_description: 'AMAZON MKTPL', payment_channel: 'online' }),
    t('t2', { amount_cents: 3000, category_primary: 'GROCERIES', counterparty: 'AMZN Mktp US',
              merchant_entity_id: 'ent_amazon', date: '2026-08-05',
              original_description: 'AMZN MKTP US*2K4', payment_channel: 'online' }),
    t('t3', { amount_cents: 2000, category_primary: 'FOOD_AND_DRINK', counterparty: 'Blue Bottle',
              date: '2026-07-20', authorized_date: '2026-07-19',
              category_confidence: 'VERY_HIGH', location_city: 'Oakland', location_region: 'CA' }),
    t('t4', { amount_cents: -200_000, category_primary: 'INCOME', counterparty: 'Employer',
              date: '2026-08-01', payment_channel: 'other', transaction_code: 'direct deposit' }),
    t('t5', { amount_cents: 9900, category_primary: 'FOOD_AND_DRINK', counterparty: 'Sushi',
              status: 'pending', date: '2026-08-15' }),
    t('t6', { amount_cents: 4000, category_primary: 'TRAVEL', counterparty: 'BART',
              account_id: 'acc_2', date: '2026-08-08' }),
  ]);
  return db;
}

/** Extra loan account for liabilities tests. Does not change seedDb's account count. */
export function addLoanAccount(db: Db, id: string, over: Partial<AccountUpsert> = {}): void {
  upsertAccount(db, {
    id,
    item_id: 'item_1',
    name: 'Mortgage',
    official_name: null,
    institution: 'Chase',
    type: 'loan',
    subtype: 'mortgage',
    mask: '9999',
    iso_currency_code: 'USD',
    available_balance_cents: null,
    current_balance_cents: 30_000_000,
    limit_cents: null,
    ...over,
  });
}
