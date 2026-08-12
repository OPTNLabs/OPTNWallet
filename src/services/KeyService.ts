import { store } from '../redux/store';
import { selectCurrentNetwork } from '../redux/selectors/networkSelectors';
import KeyManager from '../apis/WalletManager/KeyManager';
import KeyGeneration from '../apis/WalletManager/KeyGeneration';

function isString(value: any): value is string {
  return typeof value === 'string';
}

function isArrayBufferLike(value: any): value is ArrayBufferLike {
  return value instanceof Uint8Array || value instanceof ArrayBuffer;
}

const KeyService = {
  async generateMnemonic() {
    const keyGen = KeyGeneration();
    return await keyGen.generateMnemonic();
  },

  async retrieveKeys(walletId: number) {
    const keyManager = KeyManager();
    return await keyManager.retrieveKeys(walletId);
  },

  async createKeys(
    walletId: number,
    accountNumber: number,
    changeNumber: number,
    addressNumber: number
  ) {
    const state = store.getState();
    const currentNetwork = selectCurrentNetwork(state);
    const keyManager = KeyManager();

    await keyManager.createKeys(
      walletId,
      accountNumber,
      changeNumber,
      addressNumber,
      currentNetwork // Pass network type to KeyManager
    );
  },

  // Consolidate the private key fetching and type handling here
  async fetchAddressPrivateKey(address: string): Promise<Uint8Array | null> {
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
};

export default KeyService;
