import { Network } from '../state/slices/networkSlice';

export enum WalletType {
  STANDARD = 'standard',
  QUANTUMROOT = 'quantumroot',
}

/**
 * Desktop-only wallet types that are stored in the `wallets.walletType` TEXT
 * column but deliberately not added to the shared WalletType enum (that file
 * is the original author's). Downstream code that needs to branch on them
 * compares against the string values from the desktop feature that owns them.
 */
export type ExtendedWalletType = WalletType | 'watch-only' | 'hardware';

export type DerivationPathSource = 'default' | 'custom';

export type WalletLookup = {
  mnemonic: string;
  passphrase: string;
  networkType?: Network;
  walletType?: ExtendedWalletType;
  derivationPath?: string;
  derivationPathSource?: DerivationPathSource;
};

export type WalletRecord = {
  id: number;
  wallet_name: string | null;
  mnemonic: string;
  passphrase: string;
  networkType: Network | null;
  walletType: ExtendedWalletType;
  balance: number | null;
  derivation_path: string;
  derivation_path_source: DerivationPathSource;
};

/** Non-secret fields needed to open/render a wallet session. */
export type WalletMetadata = Omit<WalletRecord, 'mnemonic' | 'passphrase'>;
