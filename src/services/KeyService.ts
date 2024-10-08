import KeyManager from '../apis/WalletManager/KeyManager';

const KeyService = {
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
    const keyManager = KeyManager();
    await keyManager.createKeys(
      walletId,
      accountNumber,
      changeNumber,
      addressNumber
    );
  },

  async fetchAddressPrivateKey(address: string) {
    const keyManager = KeyManager();
    return keyManager.fetchAddressPrivateKey(address);
  },
};

export default KeyService;
