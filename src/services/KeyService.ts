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
import type { SignedMessageResponseI } from '../types/types';
import { Network } from '../redux/networkSlice';

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
