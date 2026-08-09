// P2P CashFusion onion-wrapped outputs — Phase 3 privacy layer.
//
// Each output is onion-wrapped through all peers in the mix order. Each layer
// uses ECDH + AES-GCM: a fresh ephemeral key encrypts to the next peeler's
// public key. The peeler decrypts with their private key, shuffles the batch,
// and forwards.
//
// What this actually buys, stated precisely: the LAST peeler does see every
// output in plaintext. What it cannot do — and what no peeler can do — is say
// which peer contributed which output, because every hop shuffled the batch.
// One honest hop is enough for that. So the property is unlinkability, not
// secrecy from the final hop; an earlier comment here claimed "no single peer
// sees all outputs at once", which is not true and was never true.
//
// Ported from 00-Wallet's onion-crypto.js — see
// `D:\OPTN wallet work\00-wallet\landing\onion-crypto.ts`, the reference
// checkout — using tiny-secp256k1 for ECDH and Web Crypto for AES-GCM to match
// the rest of this codebase. Protocol v3 enlarges only the fixed plaintext
// block so every output can carry its unlinkable authorization credential.

import * as ecc from 'tiny-secp256k1';
import { sha256 } from '@bitauth/libauth';

/**
 * Uniform protocol-v3 plaintext size. A standard P2PKH script (50 hex chars),
 * value (<=8 decimal chars in normal tiers), serial (64 hex), credential
 * (128 hex), separators, and sentinel need ~254 bytes. 384 leaves bounded
 * headroom while keeping every output blob indistinguishable by length.
 */
export const ONION_PAD_SIZE = 384;

export interface AuthorizedOnionOutput {
  script: string;
  value: number;
  credentialSerial: string;
  credentialSig: string;
  /** v4: sha256(salt) binding the EC Output Component credential. */
  saltCommitment: string;
}

const HEX_64 = /^[0-9a-f]{64}$/i;
const HEX_128 = /^[0-9a-f]{128}$/i;

export function encodeAuthorizedOutput(output: AuthorizedOnionOutput): string {
  if (!/^[0-9a-f]+$/i.test(output.script) || output.script.length % 2 !== 0) {
    throw new Error('authorized output script must be canonical hex');
  }
  if (!Number.isSafeInteger(output.value) || output.value < 546) {
    throw new Error('authorized output value is below dust or invalid');
  }
  if (!HEX_64.test(output.credentialSerial)) {
    throw new Error('authorized output serial must be 32-byte hex');
  }
  if (!HEX_128.test(output.credentialSig)) {
    throw new Error('authorized output credential must be 64-byte hex');
  }
  if (!HEX_64.test(output.saltCommitment)) {
    throw new Error('authorized output saltCommitment must be 32-byte hex');
  }
  return `${output.script.toLowerCase()}|${output.value}|${output.credentialSerial.toLowerCase()}|${output.credentialSig.toLowerCase()}|${output.saltCommitment.toLowerCase()}`;
}

export function decodeAuthorizedOutput(payload: string): AuthorizedOnionOutput {
  const parts = payload.split('|');
  if (parts.length !== 5) throw new Error('malformed authorized output');
  const [script, valueText, credentialSerial, credentialSig, saltCommitment] =
    parts;
  const value = Number(valueText);
  const output = {
    script,
    value,
    credentialSerial,
    credentialSig,
    saltCommitment,
  };
  encodeAuthorizedOutput(output);
  if (String(value) !== valueText) {
    throw new Error('authorized output value is not canonical');
  }
  return output;
}

/**
 * Probe whether tiny-secp256k1 WASM is loaded and functional.
 * Returns true if onion crypto can be used in this environment.
 */
export function isEccAvailable(): boolean {
  try {
    // Test a trivial scalar multiply — if WASM loaded, this succeeds.
    const priv = new Uint8Array(32);
    priv[0] = 1; // smallest valid private key
    ecc.pointFromScalar(priv, true);
    return true;
  } catch {
    return false;
  }
}

/**
 * Compute ECDH shared secret: SHA256(pointMultiply(pubKey, privKey).x).
 * Returns 32 bytes (the raw shared secret, not compressed point).
 */
function computeSharedSecret(
  privKey: Uint8Array,
  pubKey: Uint8Array
): Uint8Array {
  const point = ecc.pointMultiply(pubKey, privKey);
  if (!point) throw new Error('ECDH point multiplication failed');
  // Take x-coordinate (bytes 1-32 of compressed point) and SHA-256 it
  const xCoord = point.slice(1, 33);
  const hash = sha256.hash(xCoord);
  return new Uint8Array(hash);
}

/**
 * One onion layer: ECDH key agreement + AES-GCM encryption.
 * Returns: ephemeral pubkey (33 bytes) || IV (12 bytes) || ciphertext
 */
export async function onionLayer(
  data: Uint8Array,
  peelerPubHex: string
): Promise<Uint8Array> {
  // Generate fresh ephemeral key for this layer
  const ephPriv = crypto.getRandomValues(new Uint8Array(32));
  const ephPub = ecc.pointFromScalar(ephPriv, true);
  if (!ephPub) throw new Error('ephemeral key derivation failed');

  // ECDH shared secret
  const shared = computeSharedSecret(ephPriv, liftPeelerPubKey(peelerPubHex));
  // The scalar is done with; don't leave it for the GC to get around to.
  ephPriv.fill(0);

  // Derive AES key from shared secret (first 32 bytes)
  const aesKey = await crypto.subtle.importKey(
    'raw',
    shared,
    { name: 'AES-GCM' },
    false,
    ['encrypt']
  );

  // Encrypt with AES-GCM
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, tagLength: 128 },
      aesKey,
      data
    )
  );

  // Return: ephemeral pubkey (33 bytes) || IV (12 bytes) || ciphertext
  const result = new Uint8Array(33 + 12 + ct.length);
  result.set(ephPub, 0); // compressed pubkey (33 bytes)
  result.set(iv, 33);
  result.set(ct, 45);
  return result;
}

/**
 * Peel one onion layer: ECDH key agreement + AES-GCM decryption.
 * Input: ephemeral pubkey (33 bytes) || IV (12 bytes) || ciphertext
 * Returns: decrypted inner data
 */
export async function onionPeel(
  blob: Uint8Array,
  myPriv: Uint8Array
): Promise<Uint8Array> {
  // Parse blob
  const ephPub = blob.slice(0, 33);
  const iv = blob.slice(33, 45);
  const ct = blob.slice(45);

  // ECDH shared secret
  const shared = computeSharedSecret(myPriv, ephPub);

  // Derive AES key from shared secret
  const aesKey = await crypto.subtle.importKey(
    'raw',
    shared,
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  );

  // Decrypt
  const pt = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, tagLength: 128 },
      aesKey,
      ct
    )
  );

  return pt;
}

/**
 * Turn a peeler identifier into a point tiny-secp256k1 will accept.
 *
 * `mixOrder` entries are Nostr pubkeys: x-only, 32 bytes, 64 hex chars (see
 * `validParticipants`' HEX_64 check and `identity.ts`). `pointMultiply` rejects
 * anything that is not a 33- or 65-byte DER point, so the x-coordinate has to be
 * lifted back to a full point first. 00-Wallet does exactly this — `h2b('02' +
 * peelerPubHex)` in `onion-crypto.ts:28`.
 *
 * Assuming even Y is safe: d.G and (n-d).G differ only by negation and share an
 * x-coordinate, so the peeler derives the same secret whichever parity its real
 * key has. This is the same reason BIP-340 and NIP-44 ECDH are x-only.
 *
 * Compressed input is accepted too, so a caller that already holds a full point
 * does not have to strip it first.
 */
function liftPeelerPubKey(hex: string): Uint8Array {
  if (hex.length === 64) return hexToBytes('02' + hex);
  if (hex.length === 66) return hexToBytes(hex);
  throw new Error(
    `onion: peeler pubkey must be 64 (x-only) or 66 (compressed) hex chars, got ${hex.length}`
  );
}

/** Convert hex string to Uint8Array. */
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Onion-wrap a payload through all peelers in reverse order.
 * Each layer encrypts to one peeler's public key.
 * Returns: multi-layered onion blob
 */
export async function onionWrap(
  payload: string,
  peelerPubHexes: string[]
): Promise<Uint8Array> {
  // Pad payload to ONION_PAD_SIZE bytes (matches 00-Wallet)
  const raw = new TextEncoder().encode(payload);
  // The fixed block is what makes every blob on the wire look alike, so an
  // over-long payload is a protocol error, not something to truncate. Say so
  // plainly — `padded.set` would otherwise surface as "offset is out of bounds".
  // One byte is reserved for the sentinel.
  if (raw.length >= ONION_PAD_SIZE) {
    throw new Error(
      `onion payload too large: ${raw.length} bytes, limit ${ONION_PAD_SIZE - 1}`
    );
  }
  const padded = new Uint8Array(ONION_PAD_SIZE);
  padded.set(raw);
  padded[raw.length] = 1; // sentinel byte

  // Wrap layers in reverse order (last peeler encrypts first)
  let data = padded;
  for (let i = peelerPubHexes.length - 1; i >= 0; i--) {
    data = await onionLayer(data, peelerPubHexes[i]);
  }

  return data;
}

/**
 * Unpad a decrypted onion payload.
 * Returns: { addr, value } or { addr, value: 0 } if parsing fails
 */
export function onionUnpadRaw(data: Uint8Array): string {
  const idx = data.indexOf(1);
  return new TextDecoder().decode(data.slice(0, idx > 0 ? idx : data.length));
}

export function onionUnpad(data: Uint8Array): { addr: string; value: number } {
  const str = onionUnpadRaw(data);
  const sep = str.lastIndexOf('|');
  if (sep > 0) {
    return {
      addr: str.slice(0, sep),
      value: parseInt(str.slice(sep + 1)) || 0,
    };
  }
  return { addr: str, value: 0 };
}
