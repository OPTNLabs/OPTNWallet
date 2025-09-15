/**
 * KeyGeneration.ts
 *
 * Purpose:
 * - Encapsulates mnemonic generation and HD key derivation for BCH using @bitauth/libauth.
 * - Returns raw key material (priv/pub), PKH, and CashAddr (with and without token capabilities).
 *
 * Notes:
 * - Uses BIP39 mnemonics and BIP44 paths: m/44'/coin_type'/account'/change/address.
 * - Coin type is selected from constants (COIN_TYPE), respecting mainnet vs chipnet/testnet.
 * - Address encoding uses CashAddr (encodeCashAddress), with 'p2pkh' and 'p2pkhWithTokens'.
 *
 * Security:
 * - Private keys and mnemonics are kept in memory; consider secure memory zeroization if feasible in JS.
 * - Consider encrypting persisted keys (sql.js stores plaintext by default) — handled elsewhere.
 *
 * @suggestion Performance:
 * - If deriving many addresses at once, avoid calling `mnemonicToSeed` repeatedly; derive the root node once and reuse.
 * - Consider a batch-derivation API that takes (account, change, startIndex, count) and yields N addresses in one pass.
 * - Heavy derivations can be moved to a Web Worker to keep the UI responsive.
 *
 * @suggestion Validation:
 * - Before deriving, validate mnemonics with `bip39.validateMnemonic` to catch user typos early.
 */

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

  /**
   * Generate a BIP39 mnemonic (default strength = 128 bits).
   *
   * @returns {Promise<string>} A space-separated 12-word mnemonic phrase.
   *
   * @suggestion:
   * - Allow passing strength (128/160/192/224/256) for power users.
   * - Consider letting callers provide their own entropy for auditability.
   */
  async function generateMnemonic(): Promise<string> {
    const mnemonic = bip39.generateMnemonic();
    // console.log('Generated mnemonic:', mnemonic);
    return mnemonic;
  }

  /**
   * Derive keys and addresses using BIP44 path:
   *   m/44'/${'coin_type'}'/${'account_index'}'/${'change_index'}/${'address_index'}
   *
   * @param networkType Network (MAINNET or CHIPNET/TESTNET)
   * @param mnemonic BIP39 mnemonic
   * @param passphrase Optional BIP39 passphrase (a.k.a. "25th word")
   * @param account_index BIP44 account index (hardened)
   * @param change_index 0 for external/receive, 1 for internal/change
   * @param address_index Address index under the change branch
   *
   * @returns {{
   *   alicePub: Uint8Array | string, // compressed public key (string indicates error from lib)
   *   alicePriv: Uint8Array,         // private key (32 bytes)
   *   alicePkh: Uint8Array,          // hash160(pubkey)
   *   aliceAddress: string,          // CashAddr p2pkh
   *   aliceTokenAddress: string      // CashAddr p2pkhWithTokens
   * } | null}
   *
   * @throws Error if derivation fails
   *
   * @suggestion:
   * - Return a typed object with explicit field names (no "alice*" naming) to reduce ambiguity.
   * - Consider returning the full derivation path alongside the result for debugging.
   * - Consider returning both token and non-token addresses only if needed by caller (reduce work if unnecessary).
   */
  async function generateKeys(
    networkType: Network,
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

    // NOTE: bip39.mnemonicToSeed returns a Node Buffer (which extends Uint8Array).
    // To satisfy strict TS typings expecting Uint8Array, wrap it explicitly:
    const seedBuffer = await bip39.mnemonicToSeed(mnemonic, passphrase);
    const seed = new Uint8Array(
      seedBuffer.buffer,
      seedBuffer.byteOffset,
      seedBuffer.byteLength
    );

    // Defining rootNode as type HdNode
    const rootNode: HdNode = deriveHdPrivateNodeFromSeed(seed, {
      assumeValidity: true,
    });

    const baseDerivationPath = `m/44'/${coin_type}'/${account_index}'`;

    // Defining aliceNode as type HdNode
    const aliceNode: HdNode | string = deriveHdPath(
      rootNode,
      `${baseDerivationPath}/${change_index}/${address_index}`
    );

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

    const alicePkh: Uint8Array = hash160(alicePub);
    if (!alicePkh) {
      console.error('Failed to generate public key hash.');
      return null;
    }

    // Use the network type provided as a parameter
    const prefix = networkType === Network.MAINNET ? 'bitcoincash' : 'bchtest';

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
