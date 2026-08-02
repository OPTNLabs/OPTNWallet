import { Network } from '../state/slices/networkSlice';

export enum WalletType {
  STANDARD = 'standard',
  QUANTUMROOT = 'quantumroot',
  /**
   * Public keys only — an account xPub, no mnemonic and no private keys.
   *
   * It can watch balances and build transactions, but every signature comes
   * from an external device. Anything that assumes a wallet can sign must check
   * for this rather than discovering it when signing returns nothing.
   */
  WATCH_ONLY = 'watch-only',
}

/** Can this wallet produce a signature on its own? */
export function canSignLocally(walletType: string | null | undefined): boolean {
  return walletType !== WalletType.WATCH_ONLY;
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
