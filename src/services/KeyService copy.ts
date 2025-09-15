/**
 * KeyService.ts
 *
 * Purpose:
 * - Thin service layer that coordinates Redux network selection and KeyManager/KeyGeneration.
 * - Exposes simple methods to the rest of the app (generateMnemonic, retrieveKeys, createKeys, fetchAddressPrivateKey).
 *
 * Design:
 * - Factory-based managers (KeyManager/KeyGeneration) are instantiated per call — OK for simplicity; can be cached if needed.
 *
 * @suggestion:
 * - Consider memoizing KeyManager/KeyGeneration instances if they have internal state worth reusing.
 * - Consider adding batch APIs for address derivation (create multiple addresses at once).
 * - Standardize key material handling (Uint8Array vs base64) in one utility to reduce conversions.
 */

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
  /**
   * Generate a new BIP39 mnemonic
   * @returns {Promise<string>} 12-word mnemonic
   */
  async generateMnemonic() {
    const keyGen = KeyGeneration();
    return await keyGen.generateMnemonic();
  },

  /**
   * Retrieve all keys for a given wallet
   * @param walletId Wallet ID
   * @returns Promise of key records
   */
  async retrieveKeys(walletId: number) {
    const keyManager = KeyManager();
    return await keyManager.retrieveKeys(walletId);
  },

  /**
   * Create and persist a new derived key/address for the current network
   *
   * @param walletId Wallet ID
   * @param accountNumber BIP44 account index
   * @param changeNumber Change branch (0 external, 1 internal)
   * @param addressNumber Address index
   * @returns {Promise<void>}
   *
   * @suggestion:
   * - Add an overload that accepts an array of address indices to create a batch in one transaction.
   */
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

  /**
   * Fetch private key by address and normalize to Uint8Array
   *
   * @param address CashAddr string
   * @returns {Promise<Uint8Array | null>} Private key or null if not found
   *
   * @suggestion:
   * - Consider returning a discriminated union { ok: true, key: Uint8Array } | { ok: false, error: string }
   *   for clearer upstream handling instead of logging + null.
   */
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
