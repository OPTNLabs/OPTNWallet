import {
  deriveHdPath,
  secp256k1,
  encodeCashAddress,
  deriveHdPrivateNodeFromSeed,
} from '@bitauth/libauth';
import { hash160 } from '@cashscript/utils';
import * as bip39 from 'bip39';
import { Network } from '../../redux/networkSlice';
import { HdNode } from '../../types/types';
import { COIN_TYPE } from '../../utils/constants';

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
  ): Promise<{
    alicePub: Uint8Array | string;
    alicePriv: Uint8Array;
    alicePkh: Uint8Array;
    aliceAddress: string;
    aliceTokenAddress: string;
  } | null> {
    // Assign coin_type based on network type
    const coin_type =
      networkType === Network.MAINNET
        ? COIN_TYPE.bitcoincash
        : COIN_TYPE.testnet;

    // console.log('Generating seed...');
    const seed: Uint8Array = await bip39.mnemonicToSeed(mnemonic, passphrase);

    // Defining rootNode as type HdNode
    const rootNode: HdNode = deriveHdPrivateNodeFromSeed(seed, {
      assumeValidity: true,
    });
    // console.log('rootNode:', rootNode);

    const baseDerivationPath = `m/44'/${coin_type}'/${account_index}'`;

    // console.log('Deriving HD path...');
    // Defining aliceNode as type HdNode
    const aliceNode: HdNode | string = deriveHdPath(
      rootNode,
      `${baseDerivationPath}/${change_index}/${address_index}`
    );

    // console.log('aliceNode:', aliceNode);

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

    // console.log('Hashing public key...');
    const alicePkh: Uint8Array = hash160(alicePub);
    if (!alicePkh) {
      console.error('Failed to generate public key hash.');
      return null;
    }

    // Use the network type provided as a parameter
    const prefix = networkType === Network.MAINNET ? 'bitcoincash' : 'bchtest';

    // console.log('Encoding address...');
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

    return {
      alicePub,
      alicePriv,
      alicePkh,
      aliceAddress,
      aliceTokenAddress,
    };
  }
}
