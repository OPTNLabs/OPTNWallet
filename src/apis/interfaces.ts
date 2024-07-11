export interface BalanceResponse {
  confirmed: number;
  unconfirmed: number;
}

export interface WalletInformation {
  id: number;
  name: string;
  mnemonic: string;
  passphrase: string;
  balance: number;
}
