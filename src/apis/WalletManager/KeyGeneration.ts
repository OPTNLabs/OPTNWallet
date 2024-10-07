// src/apis/WalletManager/KeyGeneration.ts

import {
  deriveHdPath,
  secp256k1,
  encodeCashAddress,
} from '@bitauth/libauth-v3';
import { deriveHdPrivateNodeFromSeed } from '@bitauth/libauth';
import { hash160 } from '@cashscript/utils';
import * as bip39 from 'bip39';
import { Network } from '../../redux/networkSlice';
import { store } from '../../redux/store';

export default function KeyGeneration() {
  return {
    generateMnemonic,
    generateKeys,
  };

  async function generateMnemonic(): Promise<string> {
    const mnemonic = bip39.generateMnemonic();
    console.log('Generated mnemonic:', mnemonic);
    return mnemonic;
  }

  async function generateKeys(
    mnemonic: string,
    passphrase: string,
    account_index: number,
    change_index: number,
    address_index: number
  ) {
    const state = store.getState();
    console.log('Generating seed...');
    const seed = await bip39.mnemonicToSeed(mnemonic, passphrase);
    const rootNode = deriveHdPrivateNodeFromSeed(seed, true);
    const baseDerivationPath = `m/44'/1'/${account_index}'`;

    console.log('Deriving HD path...');
    const aliceNode = deriveHdPath(
      rootNode,
      `${baseDerivationPath}/${change_index}/${address_index}`
    );

    if (typeof aliceNode === 'string') {
      console.error('Error deriving HD path:', aliceNode);
      throw new Error();
    }

    const alicePub = secp256k1.derivePublicKeyCompressed(aliceNode.privateKey);
    const alicePriv = aliceNode.privateKey;

    if (typeof alicePub === 'string') {
      console.error('Error deriving public key:', alicePub);
      return null;
    }

    console.log('Hashing public key...');
    const alicePkh = hash160(alicePub);
    if (!alicePkh) {
      console.error('Failed to generate public key hash.');
      return null;
    }
    const prefix =
      state.network.currentNetwork === Network.MAINNET
        ? 'bitcoincash'
        : 'bchtest';
    console.log('Encoding address...');
    const aliceAddress = encodeCashAddress({
      payload: alicePkh,
      prefix,
      type: 'p2pkh',
    }).address;

    const aliceTokenAddress = encodeCashAddress({
      payload: alicePkh,
      prefix,
      type: 'p2pkhWithTokens',
    }).address;

    console.log('Generated keys:', {
      alicePub,
      alicePriv,
      alicePkh,
      aliceAddress,
      aliceTokenAddress,
    });

    return {
      alicePub,
      alicePriv,
      alicePkh,
      aliceAddress,
      aliceTokenAddress,
    };
  }
}
