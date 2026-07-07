import { DerivationPath, type WalletAdapter, type SignTransactionResult } from '@wizardconnect/wallet';
import type { SignTransactionRequest } from '@wizardconnect/core';
import WalletManager from '../../apis/WalletManager/WalletManager';
import KeyService from '../KeyService';
import { Network } from '../../state/slices/networkSlice';
import {
  createDeterministicRuntimeRelayKey,
  derivePublicKeyFromXpub,
} from './derivation';
import { signWizardConnectTransaction } from './signing';
import { deriveRpaGateXpubs } from '../RpaService';
import { store } from '../../state/store';
import { signWithTrezor, signWithLedger, signWithOneKey } from '../hardware/hardwareWalletSigning';
import getElectrumAdapter from '../ElectrumAdapter';


type WalletSnapshot = {
  walletId: number;
  walletName: string;
  mnemonic: string;
  passphrase: string;
  network: Network;
  xpubs: Record<DerivationPath, string>;
  rpaExtension: Record<string, unknown>;
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

    // Pre-derive RPA gate xpubs so getExtensions() can be synchronous.
    let rpaExtension: Record<string, unknown> = {};
    const state = store.getState() as unknown as { experimental?: { rpaEnabled?: boolean } };
    if (state.experimental?.rpaEnabled) {
      try {
        const rpaXpubs = await deriveRpaGateXpubs(mnemonic, passphrase);
        rpaExtension = {
          rpa_bip47: {
            spend_path: "m/47'/145'/0'/0'",
            scan_path: "m/47'/145'/0'/1'",
            spend_xpub: rpaXpubs.spendGate,
            scan_xpub: rpaXpubs.scanGate,
          },
        };
      } catch (err) {
        console.warn('[OptnWizardWalletAdapter] RPA xpub derivation failed:', err);
      }
    }

    return new OptnWizardWalletAdapter({
      walletId,
      walletName: walletInfo.wallet_name || 'OPTN Wallet',
      mnemonic,
      passphrase,
      network,
      xpubs,
      rpaExtension,
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

  // Synchronous — xpubs were pre-derived in create() so no async work needed here.
  getExtensions(): Record<string, unknown> {
    return this.snapshot.rpaExtension;
  }

  async signTransaction(request: SignTransactionRequest): Promise<SignTransactionResult> {
    const state = store.getState() as unknown as { hardwareWallet?: { type: string; connected: boolean } };
    const hw = state.hardwareWallet;

    if (hw?.connected && hw.type === 'trezor') {
      const signedTransaction = await signWithTrezor(request, this.snapshot.network);
      return { signedTransaction };
    }

    if (hw?.connected && hw.type === 'onekey') {
      const signedTransaction = await signWithOneKey(request, this.snapshot.network);
      return { signedTransaction };
    }

    if (hw?.connected && hw.type === 'ledger') {
      const adapter = getElectrumAdapter();
      const fetchRawTx = async (txid: string): Promise<string> => {
        const result = await adapter.request('blockchain.transaction.get', txid, false);
        return result as string;
      };
      const signedTransaction = await signWithLedger(request, this.snapshot.network, fetchRawTx);
      return { signedTransaction };
    }

    if (hw?.connected && hw.type === 'keystone') {
      // Keystone uses QR-based air-gap signing — cannot sign inline here.
      // The send UI must display the QR and collect the signed result separately.
      throw new Error(
        'Keystone signing requires QR interaction. Use the Keystone signing modal from the send screen.'
      );
    }

    const signedTransaction = await signWizardConnectTransaction(request, {
      mnemonic: this.snapshot.mnemonic,
      passphrase: this.snapshot.passphrase,
      network: this.snapshot.network,
    });

    return { signedTransaction };
  }
}
