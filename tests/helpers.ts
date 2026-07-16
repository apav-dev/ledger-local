import {
  openDb,
  setAccountSynced,
  upsertAccount,
  upsertEnrollment,
  upsertTransactions,
  type Db,
  type TransactionRow,
} from '../src/core/db.js';

export const NOW = Date.UTC(2026, 6, 16); // 2026-07-16

export function seedDb(): Db {
  const db = openDb(':memory:');
  upsertEnrollment(db, { id: 'enr_1', access_token: 'tok', institution: 'Chase', created_at: 1 });
  upsertAccount(db, {
    id: 'acc_1', enrollment_id: 'enr_1', name: 'Checking', institution: 'Chase',
    type: 'depository', subtype: 'checking', last_four: '1111', currency: 'USD',
    status: 'open', available_balance: 500, ledger_balance: 500,
  });
  upsertAccount(db, {
    id: 'acc_2', enrollment_id: 'enr_1', name: 'Card', institution: 'Chase',
    type: 'credit', subtype: 'credit_card', last_four: '2222', currency: 'USD',
    status: 'open', available_balance: -200, ledger_balance: -200,
  });
  setAccountSynced(db, 'acc_1', NOW - 60_000); // 1 min ago
  setAccountSynced(db, 'acc_2', NOW - 60_000);
  const t = (id: string, over: Partial<TransactionRow>): TransactionRow => ({
    id, account_id: 'acc_1', date: '2026-07-10', description: 'X', amount: -10,
    category: null, counterparty: null, status: 'posted', type: 'card_payment',
    running_balance: null, ...over,
  });
  upsertTransactions(db, [
    t('t1', { amount: -50, category: 'groceries', counterparty: 'Costco', date: '2026-07-01' }),
    t('t2', { amount: -30, category: 'groceries', counterparty: 'Safeway', date: '2026-07-05' }),
    t('t3', { amount: -20, category: 'dining', counterparty: 'Blue Bottle', date: '2026-06-20' }),
    t('t4', { amount: 2000, category: 'income', counterparty: 'Employer', date: '2026-07-01' }),
    t('t5', { amount: -99, category: 'dining', counterparty: 'Sushi', status: 'pending', date: '2026-07-15' }),
    t('t6', { amount: -40, category: 'travel', counterparty: 'BART', account_id: 'acc_2', date: '2026-07-08' }),
  ]);
  return db;
}
