export type TellerEnvironment = 'sandbox' | 'development' | 'production';

export interface TellerInstitution {
  id: string;
  name: string;
}

export interface TellerAccount {
  id: string;
  enrollment_id: string;
  name: string;
  type: 'depository' | 'credit';
  subtype?: string;
  last_four: string;
  currency: string;
  status: string;
  institution: TellerInstitution;
}

export interface TellerBalance {
  account_id: string;
  available: string | null;
  ledger: string | null;
}

export interface TellerCounterparty {
  name?: string | null;
  type?: string | null;
}

export interface TellerTransactionDetails {
  processing_status: string;
  category?: string | null;
  counterparty?: TellerCounterparty | null;
}

export interface TellerTransaction {
  id: string;
  account_id: string;
  date: string; // yyyy-mm-dd
  description: string;
  amount: string; // signed decimal string, outflows negative
  status: 'posted' | 'pending';
  type: string;
  running_balance: string | null;
  details: TellerTransactionDetails;
}

export interface TellerApi {
  listAccounts(accessToken: string): Promise<TellerAccount[]>;
  getBalance(accessToken: string, accountId: string): Promise<TellerBalance>;
  listTransactions(
    accessToken: string,
    accountId: string,
    opts?: { count?: number; fromId?: string },
  ): Promise<TellerTransaction[]>;
}
