import { DerivationPath, type WalletAdapter, type SignTransactionResult } from '@wizardconnect/wallet';
import type { SignTransactionRequest } from '@wizardconnect/core';
import WalletManager from '../../apis/WalletManager/WalletManager';
import KeyService from '../KeyService';
import { Network } from '../../redux/networkSlice';
import {
  createDeterministicRuntimeRelayKey,
  derivePublicKeyFromXpub,
} from './derivation';
import { signWizardConnectTransaction } from './signing';

type WalletSnapshot = {
  walletId: number;
  walletName: string;
  mnemonic: string;
  passphrase: string;
  network: Network;
  xpubs: Record<DerivationPath, string>;
};

export class OptnWizardWalletAdapter implements WalletAdapter {
  walletName: string;
  walletIcon: string;

  private relayKeys = new Map<string, Uint8Array>();
  private snapshot: WalletSnapshot;

  private constructor(snapshot: WalletSnapshot) {
    this.snapshot = snapshot;
    this.walletName = snapshot.walletName;
    this.walletIcon = 'https://optnlabs.com/logo.png';
  }

  static async create(walletId: number): Promise<OptnWizardWalletAdapter> {
    const walletManager = WalletManager();
    const walletInfo = await walletManager.getWalletInfo(walletId);

    if (!walletInfo?.mnemonic) {
      throw new Error('Unable to load wallet mnemonic for WizardConnect');
    }

    const network =
      walletInfo.networkType === Network.MAINNET ? Network.MAINNET : Network.CHIPNET;
    const mnemonic = walletInfo.mnemonic;
    const passphrase = walletInfo.passphrase ?? '';
    const walletXpubs = await KeyService.getWalletXpubs(walletId);
    const xpubs = {
      [DerivationPath.Receive]: walletXpubs.receive,
      [DerivationPath.Change]: walletXpubs.change,
      [DerivationPath.Cauldron]: walletXpubs.defi,
    };

    return new OptnWizardWalletAdapter({
      walletId,
      walletName: walletInfo.wallet_name || 'OPTN Wallet',
      mnemonic,
      passphrase,
      network,
      xpubs,
    });
  }

  getRelayPrivateKey(uri: string): Uint8Array {
    const existing = this.relayKeys.get(uri);
    if (existing) {
      return existing;
    }

    const generated = createDeterministicRuntimeRelayKey(uri, this.snapshot.walletId);
    this.relayKeys.set(uri, generated);
    return generated;
  }

  getPublicKey(path: DerivationPath, index: bigint): Uint8Array {
    const xpub = this.getXpub(path);
    return derivePublicKeyFromXpub(xpub, index);
  }

  getXpub(path: DerivationPath): string {
    const xpub = this.snapshot.xpubs[path];
    if (!xpub) {
      throw new Error(`Missing xpub for path ${String(path)}`);
    }
    return xpub;
  }

  async signTransaction(request: SignTransactionRequest): Promise<SignTransactionResult> {
    const signedTransaction = await signWizardConnectTransaction(request, {
      mnemonic: this.snapshot.mnemonic,
      passphrase: this.snapshot.passphrase,
      network: this.snapshot.network,
    });

    return { signedTransaction };
  }
}
