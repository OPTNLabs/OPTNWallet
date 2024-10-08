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
import KeyManager from './KeyManager';
import DatabaseService from '../DatabaseManager/DatabaseService';
import { HdNode } from '../../types/types';

const KeyManage = KeyManager();
const dbService = DatabaseService();
export default function KeyGeneration() {
  const state = store.getState();
  const currentWalletId = state.wallet_id.currentWalletId;

  return {
    generateMnemonic,
    generateKeys,
    getKeysFromWallet,
    handleGenerateKeys,
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
  ): Promise<{
    alicePub: Uint8Array | string;
    alicePriv: Uint8Array;
    alicePkh: Uint8Array;
    aliceAddress: string;
    aliceTokenAddress: string;
  } | null> {
    console.log('Generating seed...');
    const seed: Uint8Array = await bip39.mnemonicToSeed(mnemonic, passphrase);

    // Defining rootNode as type HdNode
    const rootNode: HdNode = deriveHdPrivateNodeFromSeed(seed, true);
    console.log('rootNode:', rootNode);

    const baseDerivationPath = `m/44'/1'/${account_index}'`;

    console.log('Deriving HD path...');
    // Defining aliceNode as type HdNode
    const aliceNode: HdNode | string = deriveHdPath(
      rootNode,
      `${baseDerivationPath}/${change_index}/${address_index}`
    );

    console.log('aliceNode:', aliceNode);

    if (typeof aliceNode === 'string') {
      console.error('Error deriving HD path:', aliceNode);
      throw new Error();
    }

    const alicePub: Uint8Array | string = secp256k1.derivePublicKeyCompressed(
      aliceNode.privateKey
    );
    const alicePriv: Uint8Array = aliceNode.privateKey;

    if (typeof alicePub === 'string') {
      console.error('Error deriving public key:', alicePub);
      return null;
    }

    console.log('Hashing public key...');
    const alicePkh: Uint8Array = hash160(alicePub);
    if (!alicePkh) {
      console.error('Failed to generate public key hash.');
      return null;
    }
    const prefix =
      state.network.currentNetwork === Network.MAINNET
        ? 'bitcoincash'
        : 'bchtest';
    console.log('Encoding address...');
    const aliceAddress: string = encodeCashAddress({
      payload: alicePkh,
      prefix,
      type: 'p2pkh',
    }).address;

    const aliceTokenAddress: string = encodeCashAddress({
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
  async function handleGenerateKeys(index) {
    const currentWalletId = state.wallet_id.currentWalletId;
    if (!currentWalletId) return;

    await KeyManage.createKeys(
      currentWalletId,
      0, // accountNumber
      0, // changeNumber
      index // addressNumber based on the current index
    );
    await dbService.saveDatabaseToFile();
    const newKeys = await KeyManage.retrieveKeys(currentWalletId);
    return newKeys[newKeys.length - 1];
  }
  async function getKeysFromWallet(currentWalletId) {
    const batchAmount = 10;

    if (!currentWalletId) {
      console.log('currentWalletId is not valid: ', currentWalletId);
    }
    const existingKeys = await KeyManage.retrieveKeys(currentWalletId);
    let keyPairs = existingKeys;

    const newKeys = [];
    const keySet = new Set(existingKeys.map((key) => key.address));
    if (existingKeys.length < batchAmount) {
      for (let i = existingKeys.length; i < batchAmount; i++) {
        const newKey = await handleGenerateKeys(i);
        if (newKey && !keySet.has(newKey.address)) {
          newKeys.push(newKey);
          keySet.add(newKey.address);
        }
        // setKeyProgress(((i + 1) / batchAmount) * 100);
      }
      keyPairs = [...existingKeys, ...newKeys];
    }
    return keyPairs;
  }
}
