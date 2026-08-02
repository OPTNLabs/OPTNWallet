import { Network } from '../state/slices/networkSlice';

export enum WalletType {
  STANDARD = 'standard',
  QUANTUMROOT = 'quantumroot',
}

export type DerivationPathSource = 'default' | 'custom';

export type WalletLookup = {
  mnemonic: string;
  passphrase: string;
  networkType?: Network;
  walletType?: WalletType;
  derivationPath?: string;
  derivationPathSource?: DerivationPathSource;
};

export type WalletRecord = {
  id: number;
  wallet_name: string | null;
  mnemonic: string;
  passphrase: string;
  networkType: Network | null;
  walletType: WalletType;
  balance: number | null;
  derivation_path: string;
  derivation_path_source: DerivationPathSource;
};

/** Non-secret fields needed to open/render a wallet session. */
export type WalletMetadata = Omit<WalletRecord, 'mnemonic' | 'passphrase'>;
