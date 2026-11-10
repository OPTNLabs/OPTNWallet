import { DerivationPath, type WalletAdapter, type SignTransactionResult } from '@wizardconnect/wallet';
import type { SignTransactionRequest } from '@wizardconnect/core';
import WalletManager from '../../apis/WalletManager/WalletManager';
import KeyService from '../KeyService';
import { Network } from '../../state/slices/networkSlice';
import { derivePublicKeyFromXpub } from './derivation';
import {
  getOrCreateRuntimeRelayKey,
  hydrateRelayKeys,
} from './relayKeyStore';
import {
  pathNameToDerivationPath,
  signWizardConnectSignInProof,
  signWizardConnectTransaction,
} from './signing';
import {
  SignInProofError,
  validateSignInProofRequest,
  type ValidatedSignInProof,
} from './signInProof';
import { deriveRpaGateXpub } from '../RpaService';
import { store } from '../../state/store';
import { signWithTrezor, signWithLedger, signWithOneKey } from '../hardware/hardwareWalletSigning';
import getElectrumAdapter from '../ElectrumAdapter';
import { decodeWizardConnectTransaction } from './transaction';


import { parseNetwork } from '../../utils/networkProfile';
type WalletSnapshot = {
  walletId: number;
  walletName: string;
  mnemonic: string;
  passphrase: string;
  network: Network;
  accountPath: string;
  xpubs: Record<DerivationPath, string>;
  rpaExtension: Record<string, unknown>;
};

export class OptnWizardWalletAdapter implements WalletAdapter {
  walletName: string;
  walletIcon: string;

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
      (parseNetwork(walletInfo.networkType) ?? Network.CHIPNET);
    const mnemonic = walletInfo.mnemonic;
    const passphrase = walletInfo.passphrase ?? '';
    const walletXpubs = await KeyService.getWalletXpubs(walletId);
    const xpubs = {
      [DerivationPath.Receive]: walletXpubs.receive,
      [DerivationPath.Change]: walletXpubs.change,
      [DerivationPath.Cauldron]: walletXpubs.defi,
    };

    // Pre-derive the RPA gate xpub so getExtensions() can be synchronous.
    // One branch-3 xpub (see RpaService.deriveRpaGateXpub): index 0 = scan
    // pubkey, index 1 = spend pubkey, both derivable via unhardened CKD_pub.
    let rpaExtension: Record<string, unknown> = {};
    const state = store.getState() as unknown as { experimental?: { rpaEnabled?: boolean } };
    if (state.experimental?.rpaEnabled) {
      try {
        const { rpaXpub, rpaPath } = await deriveRpaGateXpub(
          mnemonic,
          passphrase,
          network,
          walletInfo.derivation_path
        );
        rpaExtension = {
          rpa: {
            path: rpaPath,
            xpub: rpaXpub,
            scan_index: 0,
            spend_index: 1,
          },
        };
      } catch (err) {
        console.warn('[OptnWizardWalletAdapter] RPA xpub derivation failed:', err);
      }
    }

    await hydrateRelayKeys(walletId);
    return new OptnWizardWalletAdapter({
      walletId,
      walletName: walletInfo.wallet_name || 'OPTN Wallet',
      mnemonic,
      passphrase,
      network,
      accountPath: walletInfo.derivation_path,
      xpubs,
      rpaExtension,
    });
  }

  getRelayPrivateKey(uri: string): Uint8Array {
    return getOrCreateRuntimeRelayKey(this.snapshot.walletId, uri);
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

  /**
   * Null when the request is not a sign-in proof. Throws when it claims to be
   * one but is not exactly the canonical proof for one of this wallet's own
   * P2PKH addresses. The address comes from this wallet's xpubs, never from
   * the dApp.
   */
  inspectSignInProof(request: SignTransactionRequest): ValidatedSignInProof | null {
    return validateSignInProofRequest(request, (path, index) =>
      this.getPublicKey(pathNameToDerivationPath(path), BigInt(index))
    );
  }

  get network(): Network {
    return this.snapshot.network;
  }

  private async signSignInProof(
    proof: ValidatedSignInProof,
    hw: { type: string; connected: boolean } | undefined
  ): Promise<SignTransactionResult> {
    const prefs = (store.getState() as unknown as {
      preferences?: { enableWizardSignInProofs?: boolean };
    }).preferences;
    if (prefs?.enableWizardSignInProofs === false) {
      throw new SignInProofError(
        'sign-in proofs are turned off in WizardConnect settings'
      );
    }
    // Hardware signers cannot sign this shape: the Ledger BCH app derives the
    // outpoint from a full previous transaction (there is none to fetch: the
    // outpoint is a bare hash) and Trezor/OneKey cannot express the OP_RETURN
    // output. Refuse before any Electrum lookup or device call.
    if (hw?.connected) {
      throw new SignInProofError(
        `sign-in proofs are not supported with a ${hw.type} hardware wallet yet`
      );
    }
    const signedTransaction = await signWizardConnectSignInProof(proof, {
      mnemonic: this.snapshot.mnemonic,
      passphrase: this.snapshot.passphrase,
      network: this.snapshot.network,
      accountPath: this.snapshot.accountPath,
    });
    return { signedTransaction };
  }

  async signTransaction(request: SignTransactionRequest): Promise<SignTransactionResult> {
    const state = store.getState() as unknown as { hardwareWallet?: { type: string; connected: boolean } };
    const hw = state.hardwareWallet;

    // Sign-in proofs are detected and handled before anything else, so no
    // proof ever reaches a payment signer, a hardware device, or Electrum.
    const proof = this.inspectSignInProof(request);
    if (proof) {
      return this.signSignInProof(proof, hw);
    }

    const decoded = decodeWizardConnectTransaction(request.transaction);
    request = {
      ...request,
      transaction: { ...request.transaction, ...decoded },
    };

    if (hw?.connected && hw.type === 'trezor') {
      const signedTransaction = await signWithTrezor(
        request,
        this.snapshot.network,
        this.snapshot.accountPath
      );
      return { signedTransaction };
    }

    if (hw?.connected && hw.type === 'onekey') {
      const signedTransaction = await signWithOneKey(
        request,
        this.snapshot.network,
        this.snapshot.accountPath
      );
      return { signedTransaction };
    }

    if (hw?.connected && hw.type === 'ledger') {
      const adapter = getElectrumAdapter();
      const fetchRawTx = async (txid: string): Promise<string> => {
        const result = await adapter.request('blockchain.transaction.get', txid, false);
        return result as string;
      };
      const signedTransaction = await signWithLedger(
        request,
        this.snapshot.network,
        fetchRawTx,
        this.snapshot.accountPath
      );
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
      accountPath: this.snapshot.accountPath,
    });

    return { signedTransaction };
  }
}
