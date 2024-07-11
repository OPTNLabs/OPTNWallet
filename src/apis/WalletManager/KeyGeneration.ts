import {
  // deriveHdPrivateNodeFromSeed,
  deriveHdPath,
  secp256k1,
  encodeCashAddress,
} from '@bitauth/libauth-v3';
import { deriveHdPrivateNodeFromSeed } from '@bitauth/libauth';
import { hash160 } from '@cashscript/utils';
import * as bip39 from 'bip39';

export default function KeyGeneration() {
  return {
    generateMnemonic,
    generateKeys,
  };

  async function generateMnemonic(): Promise<string> {
    const mnemonic = bip39.generateMnemonic();
    return mnemonic;
  }

  async function generateKeys(
    mnemonic: string,
    passphrase: string,
    account_index: number,
    change_index: number,
    address_index: number
  ) {
    // console.log("Mnemonic Phrase: ", mnemonic);
    // console.log("Passphrase Temporarily Disabled: ", passphrase)
    // console.log("Account Index:", account_index)
    // console.log("Change Index:", change_index)
    // console.log("Address Index:", address_index)
    const seed = await bip39.mnemonicToSeed(mnemonic, passphrase);
    // console.log("Seed: ", seed)
    const rootNode = deriveHdPrivateNodeFromSeed(seed, true);
    // console.log("Root Node:", rootNode)
    const baseDerivationPath = `m/44'/1'/${account_index}'`;

    const aliceNode = deriveHdPath(
      rootNode,
      `${baseDerivationPath}/${change_index}/${address_index}`
    );

    if (typeof aliceNode === 'string') throw new Error();

    const alicePub = secp256k1.derivePublicKeyCompressed(aliceNode.privateKey);
    const alicePriv = aliceNode.privateKey;

    if (typeof alicePub === 'string') {
      console.log('alicePub should not be a string.');
      return null;
    }

    const alicePkh = hash160(alicePub);
    if (!alicePkh) {
      console.error('Failed to generate public key hash.');
      return null;
    }

    const aliceAddress = encodeCashAddress({
      payload: alicePkh,
      prefix: 'bchtest',
      type: 'p2pkh',
    }).address;

    const aliceTokenAddress = encodeCashAddress({
      payload: alicePkh,
      prefix: 'bchtest',
      type: 'p2pkhWithTokens',
    }).address;

    return {
      alicePub,
      alicePriv,
      alicePkh,
      aliceAddress,
      aliceTokenAddress,
    };
  }
}
