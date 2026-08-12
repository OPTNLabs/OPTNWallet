import { registerPlugin } from '@capacitor/core';

export interface SecureKeyStorePlugin {
  encrypt(options: { plaintext: string }): Promise<{ ciphertext: string }>;
  decrypt(options: { ciphertext: string }): Promise<{ plaintext: string }>;
}

const SecureKeyStore = registerPlugin<SecureKeyStorePlugin>('SecureKeyStore');

export default SecureKeyStore;
