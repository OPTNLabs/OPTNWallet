import { Network } from '../state/slices/networkSlice';

export enum WalletType {
  STANDARD = 'standard',
  QUANTUMROOT = 'quantumroot',
  MULTISIG = 'multisig',
}

/**
 * Extended wallet types stored in the `wallets.walletType` TEXT column.
 * Watch-only is shared across desktop/Android/iOS; hardware remains a native
 * desktop device-backed wallet until mobile hardware transports are proven.
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
