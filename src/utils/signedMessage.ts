// src/utils/signedMessage.ts

import {
  base64ToBin,
  binToBase64,
  CashAddressType,
  encodeCashAddress,
  hexToBin,
  instantiateSecp256k1,
  instantiateSha256,
  RecoveryId,
  utf8ToBin,
} from '@bitauth/libauth';

import { derivePrefix } from './derivePublicKeyHash';
import { hash160 } from './hash160';
import {
  SignedMessageI,
  SignedMessageResponseI,
  VerifyMessageResponseI,
} from '../types/types';

/**
 * Adds the Bitcoin message signing magic prefix to the message.
 *
 * @param {string} message - The message to add the magic syntax to.
 * @returns {Uint8Array} - The binary array with magic syntax.
 */
function message_magic(message: string): Uint8Array {
  const messageBytes = utf8ToBin(message);
  const lengthHex = messageBytes.length.toString(16).padStart(2, '0');
  const payload = `\x18Bitcoin Signed Message:\n`;
  return new Uint8Array([
    ...utf8ToBin(payload),
    ...hexToBin(lengthHex),
    ...messageBytes,
  ]);
}

/**
 * Hashes the message with the Bitcoin magic prefix.
 *
 * @param {string} message - The message to hash.
 * @returns {Promise<Uint8Array>} - The double SHA-256 hash of the magic message.
 */
async function hash_message(message: string): Promise<Uint8Array> {
  const sha256Instance = await instantiateSha256();
  const hash = sha256Instance.hash;
  const magic = message_magic(message);
  const firstHash = hash(magic);
  return hash(firstHash);
}

/**
 * SignedMessage - Provides sign and verify functionalities for messages.
 */
export class SignedMessage implements SignedMessageI {
  /**
   * sign - Calculate the recoverable signed checksum of a string message.
   *
   * @param {string} message - The message to sign.
   * @param {Uint8Array} privateKey - The private key to sign the message with.
   * @returns {Promise<SignedMessageResponseI>} - The signature and related details.
   */
  public async sign(
    message: string,
    privateKey: Uint8Array
  ): Promise<SignedMessageResponseI> {
    const secp256k1 = await instantiateSecp256k1();

    const messageHash = await hash_message(message);
    const rs = secp256k1.signMessageHashRecoverableCompact(
      privateKey,
      messageHash
    );

    if (typeof rs === 'string') {
      throw new Error(rs);
    }

    const sigDer = secp256k1.signMessageHashDER(
      privateKey,
      messageHash
    ) as Uint8Array;
    const sigSchnorr = secp256k1.signMessageHashSchnorr(
      privateKey,
      messageHash
    ) as Uint8Array;
    const electronEncoding = new Uint8Array([
      31 + rs.recoveryId,
      ...rs.signature,
    ]);

    return {
      raw: {
        ecdsa: binToBase64(rs.signature),
        schnorr: binToBase64(sigSchnorr),
        der: binToBase64(sigDer),
      },
      details: {
        recoveryId: rs.recoveryId,
        compressed: true,
        messageHash: binToBase64(messageHash),
      },
      signature: binToBase64(electronEncoding),
    };
  }

  /**
   * verify - Validate that the message is valid against a given signature.
   *
   * @param {string} message - The message to verify.
   * @param {string} signature - The signature as a base64 encoded string.
   * @param {string} [cashaddr] - The Cash Address to validate against.
   * @param {Uint8Array} [publicKey] - The public key if not recoverable from the signature.
   * @returns {Promise<VerifyMessageResponseI>} - Verification result and details.
   */
  public async verify(
    message: string,
    signature: string,
    cashaddr?: string,
    publicKey?: Uint8Array
  ): Promise<VerifyMessageResponseI> {
    const secp256k1 = await instantiateSecp256k1();
    const messageHash = await hash_message(message);
    const sig = base64ToBin(signature);

    let signatureValid = false;
    let keyMatch = false;
    let pkhMatch = false;
    let pkh: Uint8Array | undefined;
    let signatureType: string | undefined;

    if (sig.length === 65) {
      const recoveryId = (sig[0] - 31) as RecoveryId;
      const rawSig = sig.slice(1);

      const recoveredPk = secp256k1.recoverPublicKeyCompressed(
        rawSig,
        recoveryId,
        messageHash
      );

      if (typeof recoveredPk === 'string') {
        throw new Error(recoveredPk);
      }

      pkh = await hash160(recoveredPk);
      signatureType = 'recoverable';
      signatureValid = secp256k1.verifySignatureCompact(
        rawSig,
        recoveredPk,
        messageHash
      );

      if (cashaddr) {
        const prefix = derivePrefix(cashaddr);
        const resultingCashaddr = encodeCashAddress({
          prefix,
          type: CashAddressType.p2pkh,
          payload: pkh,
        }).address;

        if (resultingCashaddr === cashaddr) {
          pkhMatch = true;
        }
      }
    } else if (publicKey) {
      if (secp256k1.verifySignatureDER(sig, publicKey, messageHash)) {
        signatureType = 'der';
        signatureValid = true;
        keyMatch = true;
      } else if (
        secp256k1.verifySignatureSchnorr(sig, publicKey, messageHash)
      ) {
        signatureType = 'schnorr';
        signatureValid = true;
        keyMatch = true;
      } else if (
        secp256k1.verifySignatureCompact(sig, publicKey, messageHash)
      ) {
        signatureType = 'ecdsa';
        signatureValid = true;
        keyMatch = true;
      } else {
        signatureType = 'na';
      }
    }

    return {
      valid: signatureValid && (keyMatch || pkhMatch),
      details: {
        signatureValid,
        signatureType: signatureType || 'unknown',
        messageHash: binToBase64(messageHash),
        publicKeyHashMatch: pkhMatch,
        publicKeyMatch: keyMatch,
      },
    };
  }

  /**
   * Static method to sign a message without needing to instantiate the class.
   *
   * @param {string} message - The message to sign.
   * @param {Uint8Array} privateKey - The private key to sign the message with.
   * @returns {Promise<SignedMessageResponseI>} - The signature and related details.
   */
  public static async sign(
    message: string,
    privateKey: Uint8Array
  ): Promise<SignedMessageResponseI> {
    return new this().sign(message, privateKey);
  }

  /**
   * Static method to verify a message without needing to instantiate the class.
   *
   * @param {string} message - The message to verify.
   * @param {string} signature - The signature as a base64 encoded string.
   * @param {string} [cashaddr] - The Cash Address to validate against.
   * @param {Uint8Array} [publicKey] - The public key if not recoverable from the signature.
   * @returns {Promise<VerifyMessageResponseI>} - Verification result and details.
   */
  public static async verify(
    message: string,
    signature: string,
    cashaddr?: string,
    publicKey?: Uint8Array
  ): Promise<VerifyMessageResponseI> {
    return new this().verify(message, signature, cashaddr, publicKey);
  }
}
