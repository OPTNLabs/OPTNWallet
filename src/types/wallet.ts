import { Network } from '../redux/networkSlice';

export enum WalletType {
  STANDARD = 'standard',
  QUANTUMROOT = 'quantumroot',
}

export type WalletLookup = {
  mnemonic: string;
  passphrase: string;
  networkType?: Network;
  walletType?: WalletType;
};

export type WalletRecord = {
  id: number;
  wallet_name: string | null;
  mnemonic: string;
  passphrase: string;
  networkType: Network | null;
  walletType: WalletType;
  balance: number | null;
};
