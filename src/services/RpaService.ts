// BCH Reusable Payment Address (RPA) service.
// Spec: https://github.com/imaginaryusername/Reusable_specs/blob/master/reusable_addresses.md
// Reference: Electron Cash electroncash/rpa/paycode.py
//
// Protocol summary:
//   - Recipient shares a static "paycode" (scan_pubkey + spend_pubkey, CashAddr encoded)
//   - Sender derives a unique one-time address via ECDH(sender_privkey, scan_pubkey) + outpoint hash
//   - Sender grinds signature nonce until input hash prefix matches scan_pubkey prefix
//   - Recipient queries an RPA-capable Electrum server (Fulcrum-RPA) using their paycode prefix
//   - For each matching tx, recipient checks if any output belongs to them via ECDH + CKD_pub
//
// Key paths (BIP47 hierarchy, matching WizardConnect spec):
//   Scan  private/public: m/47'/145'/0'/1'/0
//   Spend private/public: m/47'/145'/0'/0'/0

import {
  deriveHdPrivateNodeFromSeed,
  deriveHdPath,
  deriveHdPublicNode,
  deriveHdPublicNodeChild,
  encodeCashAddress,
  sha256,
  secp256k1,
} from '@bitauth/libauth';
import { hash160 } from '@cashscript/utils';
import * as bip39 from 'bip39';
import * as ecc from 'tiny-secp256k1';
import { Network } from '../state/slices/networkSlice';
import { zeroize } from '../utils/secureMemory';
import { derivePrivateKeyAtPath } from './HdWalletService';

// ─── Key derivation paths ─────────────────────────────────────────────────────

const SCAN_KEY_PATH  = "m/47'/145'/0'/1'/0";
const SPEND_KEY_PATH = "m/47'/145'/0'/0'/0";

// ─── Paycode constants ────────────────────────────────────────────────────────

// Prefix sizes (number of bits of scan_pubkey used as Electrum filter)
export const RPA_PREFIX_BITS = 8; // 1/256 bandwidth — good default

// Paycode version bytes
const VERSION_MAINNET = 0x01; // mainnet P2PKH
const VERSION_TESTNET = 0x05; // testnet P2PKH

// Paycode CashAddr prefixes
const PAYCODE_PREFIX_MAINNET = 'paycode';
const PAYCODE_PREFIX_TESTNET = 'paycodetest';

// ─── CashAddr encoding (raw, supports non-standard payload sizes) ─────────────

const CASHADDR_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const CASHADDR_CHARSET_REV: Record<string, number> = {};
for (let i = 0; i < CASHADDR_CHARSET.length; i++) {
  CASHADDR_CHARSET_REV[CASHADDR_CHARSET[i]] = i;
}

function cashAddrPolymod(values: number[]): number {
  const GEN = [0x98f2bc8e61, 0x79b76d99e2, 0xf33e5fb3c4, 0xae2eabe2a8, 0x1e4f43e470];
  let c = 1;
  for (const d of values) {
    const high = Math.floor(c / 0x800000000); // top 5 bits of 40-bit value
    c = ((c & 0x7ffffffff) * 32) ^ d;
    for (let i = 0; i < 5; i++) {
      if ((high >> i) & 1) c ^= GEN[i];
    }
  }
  return c ^ 1;
}

function prefixExpand(prefix: string): number[] {
  const result: number[] = [];
  for (const c of prefix.toLowerCase()) result.push(c.charCodeAt(0) & 0x1f);
  result.push(0);
  return result;
}

function bytesToFiveBit(data: Uint8Array): number[] {
  const out: number[] = [];
  let bits = 0, val = 0;
  for (const b of data) {
    val = ((val << 8) | b) >>> 0; // keep unsigned 32-bit to avoid sign issues
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out.push((val >>> bits) & 0x1f);
    }
    val = val & ((1 << bits) - 1); // discard already-extracted high bits
  }
  if (bits > 0) out.push((val << (5 - bits)) & 0x1f);
  return out;
}

function fiveBitToBytes(data: number[]): Uint8Array {
  const out: number[] = [];
  let bits = 0, val = 0;
  for (const d of data) {
    val = ((val << 5) | d) >>> 0;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out.push((val >>> bits) & 0xff);
    }
    val = val & ((1 << bits) - 1);
  }
  return new Uint8Array(out);
}

function cashAddrEncode(prefix: string, kindByte: number, payload: Uint8Array): string {
  const data5 = bytesToFiveBit(new Uint8Array([kindByte, ...payload]));
  const checksumInput = [...prefixExpand(prefix), ...data5, 0, 0, 0, 0, 0, 0, 0, 0];
  const mod = cashAddrPolymod(checksumInput);
  const checksum5: number[] = [];
  const modBig = BigInt(mod);
  for (let i = 7; i >= 0; i--) {
    checksum5.push(Number((modBig >> BigInt(5 * i)) & 31n));
  }

  let body = '';
  for (const c of [...data5, ...checksum5]) body += CASHADDR_CHARSET[c];
  return `${prefix}:${body}`;
}

function cashAddrDecode(addr: string): { prefix: string; kindByte: number; payload: Uint8Array } | null {
  const colon = addr.indexOf(':');
  if (colon < 0) return null;
  const prefix = addr.slice(0, colon);
  const body = addr.slice(colon + 1).toLowerCase();

  const data5: number[] = [];
  for (const c of body) {
    const v = CASHADDR_CHARSET_REV[c];
    if (v === undefined) return null;
    data5.push(v);
  }

  // Last 8 five-bit values are the checksum
  const payload5 = data5.slice(0, -8);
  const allBytes = fiveBitToBytes(payload5);
  if (allBytes.length < 1) return null;

  return { prefix, kindByte: allBytes[0], payload: allBytes.slice(1) };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function bytesToHex(b: Uint8Array): string {
  return Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
}

function bigIntToBeBytes(n: bigint): Uint8Array {
  let hex = n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export type RpaKeys = {
  scanPrivkey: Uint8Array;
  scanPubkey: Uint8Array;
  spendPrivkey: Uint8Array;
  spendPubkey: Uint8Array;
};

export type DecodedPaycode = {
  version: number;
  prefixBits: number;
  scanPubkey: Uint8Array;
  spendPubkey: Uint8Array;
  expiry: number;
};

// Derive all four RPA key materials from a mnemonic.
export async function deriveRpaKeys(mnemonic: string, passphrase: string): Promise<RpaKeys> {
  const scanPrivkey = await derivePrivateKeyAtPath(mnemonic, passphrase, SCAN_KEY_PATH);
  const spendPrivkey = await derivePrivateKeyAtPath(mnemonic, passphrase, SPEND_KEY_PATH);

  const scanPub = secp256k1.derivePublicKeyCompressed(scanPrivkey);
  const spendPub = secp256k1.derivePublicKeyCompressed(spendPrivkey);

  if (typeof scanPub === 'string') throw new Error(`Scan pubkey derivation failed: ${scanPub}`);
  if (typeof spendPub === 'string') throw new Error(`Spend pubkey derivation failed: ${spendPub}`);

  return {
    scanPrivkey: Uint8Array.from(scanPrivkey),
    scanPubkey: Uint8Array.from(scanPub),
    spendPrivkey: Uint8Array.from(spendPrivkey),
    spendPubkey: Uint8Array.from(spendPub),
  };
}

// Encode scan_pubkey + spend_pubkey as a CashAddr paycode string.
// prefixBits: how many bits of scan_pubkey to use as Electrum filter (8 = 1/256 bandwidth).
export function encodePaycode(
  scanPubkey: Uint8Array,
  spendPubkey: Uint8Array,
  network: Network,
  prefixBits = RPA_PREFIX_BITS,
): string {
  const version = network === Network.MAINNET ? VERSION_MAINNET : VERSION_TESTNET;
  const payload = new Uint8Array(72);
  payload[0] = version;
  payload[1] = prefixBits;
  payload.set(scanPubkey.slice(0, 33), 2);   // bytes 2-34
  payload.set(spendPubkey.slice(0, 33), 35); // bytes 35-67
  // bytes 68-71: expiry = 0 (no expiry)

  const prefix = network === Network.MAINNET ? PAYCODE_PREFIX_MAINNET : PAYCODE_PREFIX_TESTNET;
  return cashAddrEncode(prefix, 0x00, payload);
}

// Parse a paycode string back to its components.
export function decodePaycode(paycodeStr: string): DecodedPaycode | null {
  try {
    const decoded = cashAddrDecode(paycodeStr);
    if (!decoded) return null;
    if (decoded.payload.length < 72) return null;
    if (decoded.kindByte !== 0x00) return null;

    const p = decoded.payload;
    return {
      version:    p[0],
      prefixBits: p[1],
      scanPubkey:  new Uint8Array(p.slice(2, 35)),
      spendPubkey: new Uint8Array(p.slice(35, 68)),
      expiry: (p[68] | (p[69] << 8) | (p[70] << 16) | (p[71] << 24)) >>> 0,
    };
  } catch {
    return null;
  }
}

// Derive + encode paycode in one call (convenience wrapper).
export async function deriveAndEncodePaycode(
  mnemonic: string,
  passphrase: string,
  network: Network,
  prefixBits = RPA_PREFIX_BITS,
): Promise<string> {
  const keys = await deriveRpaKeys(mnemonic, passphrase);
  return encodePaycode(keys.scanPubkey, keys.spendPubkey, network, prefixBits);
}

// ─── Shared secret (ECDH + outpoint) ─────────────────────────────────────────
// This is the core cryptographic primitive. Both sender and receiver use it.
//
// Formula (from Electron Cash paycode.py):
//   ECDH_point  = privkey × pubkey              (point multiplication)
//   ECDH_x      = 0x00 || ECDH_point.x          (33-byte big-endian)
//   sha_ecdh    = SHA256(ECDH_x)
//   outpoint    = txid_hex_str + vout_str        (no separator, ASCII)
//   hash_out    = SHA256(outpoint_utf8)
//   grand_sum   = int(sha_ecdh) + int(hash_out) (big-endian bytes)
//   secret      = SHA256(grand_sum_bytes)
export function computeSharedSecret(
  privkey: Uint8Array,
  counterpartPubkey: Uint8Array,
  txid: string,
  vout: number,
): Uint8Array {
  // ECDH: privkey × counterpartPubkey = shared point
  const ecdhPoint = ecc.pointMultiply(counterpartPubkey, privkey);
  if (!ecdhPoint) throw new Error('ECDH point multiplication failed');

  // Extract x-coordinate as 33-byte big-endian (prepend 0x00)
  const ecdhX = new Uint8Array(33);
  ecdhX[0] = 0x00;
  ecdhX.set(ecdhPoint.slice(1, 33), 1);
  const shaEcdh = sha256.hash(ecdhX);

  // Hash the outpoint (txid string + vout string, no separator)
  const encoder = new TextEncoder();
  const hashOutpoint = sha256.hash(encoder.encode(`${txid}${vout}`));

  // Grand sum: SHA256((int(sha_ecdh) + int(hash_outpoint)).to_bytes())
  const shaEcdhInt = BigInt('0x' + bytesToHex(shaEcdh));
  const hashOutpointInt = BigInt('0x' + bytesToHex(hashOutpoint));
  const grandSum = shaEcdhInt + hashOutpointInt;
  return sha256.hash(bigIntToBeBytes(grandSum));
}

// ─── Payment address derivation (sender side) ─────────────────────────────────
// Derives the unique one-time P2PKH address a sender should pay to.
// Uses BIP32 CKD_pub with sharedSecret as the chain code.
//
//   payment_pubkey = CKD_pub(spend_pubkey, shared_secret, index)
//   payment_addr   = P2PKH(payment_pubkey)
export function derivePaymentAddress(
  spendPubkey: Uint8Array,
  sharedSecret: Uint8Array,
  network: Network,
  index = 0,
): string {
  const parentNode = {
    publicKey: Uint8Array.from(spendPubkey),
    chainCode: Uint8Array.from(sharedSecret),
    depth: 0,
    childIndex: 0,
    parentFingerprint: new Uint8Array(4),
  };
  const child = deriveHdPublicNodeChild(parentNode, index);
  if (typeof child === 'string') throw new Error(`CKD_pub failed: ${child}`);

  const pkh = hash160(Uint8Array.from(child.publicKey));
  const prefix = network === Network.MAINNET ? 'bitcoincash' : 'bchtest';
  const result = encodeCashAddress({ prefix, type: 'p2pkh', payload: pkh });
  if (typeof result === 'string') throw new Error(`Address encoding failed: ${result}`);
  return result.address;
}

// ─── Spending key derivation (recipient side) ─────────────────────────────────
// Derives the private key to spend a detected RPA payment at index `index`.
// Uses BIP32 CKD_priv with sharedSecret as the chain code.
//
//   I        = HMAC-SHA512(Key=sharedSecret, Data=spend_pubkey || uint32_be(index))
//   tweak    = I[0:32]
//   spend_key = (spend_privkey + tweak) mod n
export async function deriveSpendingKey(
  spendPrivkey: Uint8Array,
  sharedSecret: Uint8Array,
  index = 0,
): Promise<Uint8Array> {
  const spendPub = secp256k1.derivePublicKeyCompressed(spendPrivkey);
  if (typeof spendPub === 'string') throw new Error('Invalid spend private key');

  const indexBytes = new Uint8Array(4);
  new DataView(indexBytes.buffer).setUint32(0, index, false);
  const data = new Uint8Array([...Uint8Array.from(spendPub), ...indexBytes]);

  // HMAC-SHA512 via Web Crypto (available in all modern WebViews)
  // Cast needed: TS strict mode doesn't accept Uint8Array<ArrayBufferLike> for BufferSource
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const key = await crypto.subtle.importKey('raw', sharedSecret as any, { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
  const tweak = mac.slice(0, 32);

  const childKey = ecc.privateAdd(Uint8Array.from(spendPrivkey), tweak);
  if (!childKey) throw new Error('Private key derivation overflowed — extremely unlikely');
  return childKey;
}

// ─── XPub gate derivation (for WizardConnect extension advertisement) ─────────
// Returns xpubs at the hardened gate paths.
// Safe to share: hardened derivation prevents walking up to the parent.
export async function deriveRpaGateXpubs(
  mnemonic: string,
  passphrase: string,
): Promise<{ spendGate: string; scanGate: string }> {
  const { encodeHdPublicKey } = await import('@bitauth/libauth');

  const seed = Uint8Array.from(await bip39.mnemonicToSeed(mnemonic, passphrase));
  const rootNode = deriveHdPrivateNodeFromSeed(seed, { assumeValidity: true });

  try {
    const SPEND_GATE = "m/47'/145'/0'/0'";
    const SCAN_GATE  = "m/47'/145'/0'/1'";

    const spendGateNode = deriveHdPath(rootNode, SPEND_GATE);
    const scanGateNode  = deriveHdPath(rootNode, SCAN_GATE);

    if (typeof spendGateNode === 'string') throw new Error(`Spend gate failed: ${spendGateNode}`);
    if (typeof scanGateNode === 'string') throw new Error(`Scan gate failed: ${scanGateNode}`);

    const encodeXpub = (node: ReturnType<typeof deriveHdPublicNode>) => {
      const r = encodeHdPublicKey({ network: 'mainnet', node });
      if (typeof r === 'string') throw new Error(`xpub encode failed: ${r}`);
      return r.hdPublicKey;
    };

    return {
      spendGate: encodeXpub(deriveHdPublicNode(spendGateNode)),
      scanGate:  encodeXpub(deriveHdPublicNode(scanGateNode)),
    };
  } finally {
    zeroize(seed);
    zeroize(rootNode.privateKey);
  }
}
