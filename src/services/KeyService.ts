import { store } from '../redux/store';
import { selectCurrentNetwork } from '../redux/selectors/networkSelectors';
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
import { Network } from '../redux/networkSlice';
import type { deriveQuantumrootVault } from './QuantumrootService';

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
    batchSize = 10
  ): Promise<void> {
    const existingKeys = await KeyService.retrieveKeys(walletId);
    if (existingKeys.length > 0) {
      return;
    }

    for (let index = 0; index < batchSize; index += 1) {
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

  // Consolidate the private key fetching and type handling here
  async fetchAddressPrivateKey(address: string): Promise<Uint8Array | null> {
    await DeviceIntegrityService.assertDeviceIntegrity('fetchAddressPrivateKey');
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
    const privateKey = await this.fetchAddressPrivateKey(address);
    if (!privateKey) {
      throw new Error(`Missing private key for address: ${address}`);
    }
    return await SignedMessage.sign(message, privateKey);
  },
};

export default KeyService;
