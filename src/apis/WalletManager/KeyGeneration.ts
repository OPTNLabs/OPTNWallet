import * as bip39 from 'bip39';
import { Network } from '../../redux/networkSlice';
import {
  deriveBchKeyMaterial,
  type DerivedBchKeyMaterial,
} from '../../services/HdWalletService';

export default function KeyGeneration() {
  return {
    generateMnemonic,
    generateKeys,
  };

  async function generateMnemonic(): Promise<string> {
    const mnemonic = bip39.generateMnemonic();
    // console.log('Generated mnemonic:', mnemonic);
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
