import { Network } from '../../state/slices/networkSlice';
import {
  deriveBchKeyMaterial,
  type DerivedBchKeyMaterial,
} from '../../services/HdWalletService';
import {
  generateBip39Mnemonic,
  type Bip39Language,
} from '../../services/Bip39Service';

export default function KeyGeneration() {
  return {
    generateMnemonic,
    generateKeys,
  };

  async function generateMnemonic(
    language: Bip39Language = 'english'
  ): Promise<string> {
    const mnemonic = generateBip39Mnemonic(language);
    return mnemonic;
  }

  async function generateKeys(
    networkType: Network, // Accept networkType as a parameter
    mnemonic: string,
    passphrase: string,
    account_index: number,
    change_index: number,
    address_index: number
  ): Promise<DerivedBchKeyMaterial | null> {
    return deriveBchKeyMaterial(
      networkType,
      mnemonic,
      passphrase,
      account_index,
      change_index,
      address_index
    );
  }
}
