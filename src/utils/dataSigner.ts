// utils/DataSigner.ts
import { secp256k1 } from '@bitauth/libauth';
import { sha256, encodeString } from '@cashscript/utils';

export class DataSigner {
  constructor(public privateKey: Uint8Array) {}

  /**
   * Encodes a password string into a Uint8Array using UTF-8 encoding.
   *
   * @param password - The password string to encode.
   * @returns A Uint8Array containing the UTF-8 encoded password.
   */
  createMessage(password: string): Uint8Array {
    return encodeString(password);
  }

  /**
   * Signs a given message using the Schnorr signature scheme.
   * The message is first hashed using SHA-256 before signing.
   *
   * @param message - The message to be signed as a Uint8Array.
   * @returns The Schnorr signature as a Uint8Array.
   * @throws An error if the signing process fails.
   */
  signMessage(message: Uint8Array): Uint8Array {
    const messageHash = sha256(message);
    const signature = secp256k1.signMessageHashSchnorr(
      this.privateKey,
      messageHash
    );

    if (typeof signature === 'string') {
      throw new Error('Failed to sign message');
    }

    return signature;
  }
}
