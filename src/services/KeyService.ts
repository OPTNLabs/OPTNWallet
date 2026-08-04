import { store } from '../state/store';
import { selectCurrentNetwork } from '../state/selectors/networkSelectors';
import KeyManager from '../apis/WalletManager/KeyManager';
import WalletManager from '../apis/WalletManager/WalletManager';
import KeyGeneration from '../apis/WalletManager/KeyGeneration';
import type {
  BchStandardBranchName,
  DerivedBchPublicAddress,
} from './HdWalletService';
import { isArrayBufferLike, isString } from '../utils/typeGuards';
import { SignedMessage } from '../utils/signed';
import DeviceIntegrityService from './DeviceIntegrityService';
import type { QuantumrootVaultRecord, SignedMessageResponseI } from '../types/types';
import { Network } from '../state/slices/networkSlice';
import type { deriveQuantumrootVault } from './QuantumrootService';

/**
 * Why a caller wants a private key. Platform integrity services decide what
 * each one costs the user:
 *
 * - `spend`      producing a signature that moves funds or binds the user to
 *                something. May re-prompt for the wallet password.
 * - `reveal`     handing the key itself to the user (WIF export). Always
 *                re-prompts — the key leaves the app's control.
 * - `background` unattended use the user already consented to, such as
 *                auto-fusion. Must never prompt, or rounds die mid-flight.
 */
export type KeyPurpose = 'spend' | 'reveal' | 'background';

const KEY_PURPOSE_SCOPES: Record<KeyPurpose, string> = {
  spend: 'fetchAddressPrivateKey_spend',
  reveal: 'private_key_reveal',
  background: 'fetchAddressPrivateKey',
};

const KeyService = {
  async generateMnemonic() {
    const keyGen = KeyGeneration();
    return await keyGen.generateMnemonic();
  },

  async retrieveKeys(walletId: number) {
    const keyManager = KeyManager();
    return await keyManager.retrieveKeys(walletId);
  },

  async getWalletXpubs(
    walletId: number,
    accountNumber = 0
  ): Promise<Record<BchStandardBranchName, string>> {
    const keyManager = KeyManager();
    return await keyManager.getXpubs(walletId, accountNumber);
  },

  async deriveWalletAddressFromXpub(
    walletId: number,
    branchName: BchStandardBranchName,
    addressIndex: number | bigint,
    accountNumber = 0
  ): Promise<DerivedBchPublicAddress> {
    const keyManager = KeyManager();
    return await keyManager.deriveAddressFromXpub(
      walletId,
      branchName,
      addressIndex,
      accountNumber
    );
  },

  async createKeys(
    walletId: number,
    accountNumber: number,
    changeNumber: number,
    addressNumber: number
  ) {
    const state = store.getState();
    const currentNetwork = selectCurrentNetwork(state);
    const walletManager = WalletManager();
    const walletInfo = await walletManager.getWalletInfo(walletId);
    const resolvedNetwork =
      walletInfo?.networkType === Network.MAINNET
        ? Network.MAINNET
        : walletInfo?.networkType === Network.CHIPNET
          ? Network.CHIPNET
          : currentNetwork;
    const keyManager = KeyManager();

    await keyManager.createKeys(
      walletId,
      accountNumber,
      changeNumber,
      addressNumber,
      resolvedNetwork
    );
  },

  async bootstrapInitialAddressBatch(
    walletId: number,
    accountNumber = 0,
    batchSize = 20
  ): Promise<void> {
    if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
      throw new Error('Initial address batch size must be a positive integer.');
    }

    for (let index = 0; index < batchSize; index += 1) {
      // createKeys is idempotent for an already persisted key. Top up a
      // partially initialized wallet instead of treating the first row as a
      // complete bootstrap; this matters when a worker starts during restore.
      await KeyService.createKeys(walletId, accountNumber, 0, index);
      await KeyService.createKeys(walletId, accountNumber, 1, index);
    }
  },

  async createQuantumrootVault(
    walletId: number,
    addressIndex: number,
    accountNumber = 0
  ): Promise<QuantumrootVaultRecord> {
    const keyManager = KeyManager();
    return await keyManager.createQuantumrootVault(walletId, addressIndex, accountNumber);
  },

  async configureQuantumrootVault(
    walletId: number,
    addressIndex: number,
    accountNumber = 0,
    onlineQuantumSigner: 0 | 1 = 0,
    vaultTokenCategory = '00'.repeat(32)
  ): Promise<QuantumrootVaultRecord> {
    const keyManager = KeyManager();
    return await keyManager.configureQuantumrootVault(
      walletId,
      addressIndex,
      accountNumber,
      onlineQuantumSigner,
      vaultTokenCategory
    );
  },

  async retrieveQuantumrootVaults(
    walletId: number
  ): Promise<QuantumrootVaultRecord[]> {
    const keyManager = KeyManager();
    return await keyManager.retrieveQuantumrootVaults(walletId);
  },

  async deriveQuantumrootVault(
    walletId: number,
    addressIndex: number,
    accountNumber = 0,
    onlineQuantumSigner: '0' | '1' = '0',
    vaultTokenCategory = '00'.repeat(32)
  ): Promise<Awaited<ReturnType<typeof deriveQuantumrootVault>>> {
    const keyManager = KeyManager();
    return await keyManager.deriveQuantumrootVaultForWallet(
      walletId,
      addressIndex,
      accountNumber,
      onlineQuantumSigner,
      vaultTokenCategory
    );
  },

  // Consolidate the private key fetching and type handling here.
  //
  // `purpose` is required on purpose. It used to default to non-spending, so a
  // caller that simply forgot the argument got no re-auth and no warning — the
  // dangerous case was the silent one. Making it explicit means the compiler,
  // not a reviewer, catches the next spend path somebody adds.
  async fetchAddressPrivateKey(
    address: string,
    purpose: KeyPurpose
  ): Promise<Uint8Array | null> {
    await DeviceIntegrityService.assertDeviceIntegrity(KEY_PURPOSE_SCOPES[purpose]);
    const keyManager = KeyManager();
    const privateKeyData = await keyManager.fetchAddressPrivateKey(address);

    // Ensure the private key is of type Uint8Array
    if (isArrayBufferLike(privateKeyData)) {
      return new Uint8Array(privateKeyData);
    } else if (isString(privateKeyData)) {
      // Convert base64 encoded private key to Uint8Array
      return Uint8Array.from(atob(privateKeyData), (c) => c.charCodeAt(0));
    } else {
      console.error(
        'Private key data is not a recognized type:',
        privateKeyData
      );
      return null;
    }
  },

  async signMessageForAddress(
    address: string,
    message: string
  ): Promise<SignedMessageResponseI> {
    await DeviceIntegrityService.assertDeviceIntegrity('signMessageForAddress');
    const privateKey = await this.fetchAddressPrivateKey(address, 'spend');
    if (!privateKey) {
      throw new Error(`Missing private key for address: ${address}`);
    }
    return await SignedMessage.sign(message, privateKey);
  },
};

export default KeyService;
