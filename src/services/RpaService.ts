// BCH Reusable Payment Address (RPA) service.
// Spec: https://github.com/imaginaryusername/Reusable_specs/blob/master/reusable_addresses.md
// Reference: Electron Cash electroncash/rpa/paycode.py.
//
// Protocol summary:
//   - Recipient shares a static "paycode" (scan_pubkey + spend_pubkey, CashAddr encoded)
//   - Sender derives a unique one-time address via ECDH(sender_privkey, scan_pubkey) + outpoint hash
//   - Sender grinds signature nonce until input hash prefix matches scan_pubkey prefix
//   - Recipient queries an RPA-capable Electrum server (Fulcrum-RPA) using their paycode prefix
//   - For each matching tx, recipient checks if any output belongs to them via ECDH + CKD_pub
//
// Key paths — RPA rides on the wallet's normal BIP44 account as a third
// unhardened chain, sibling to receive(0)/change(1) (see HdWalletService's
// BCH_STANDARD_BRANCH_INDEX.rpa = 3), matching the Electron Cash reference
// implementation:
//   Scan  private/public: m/44'/145'/0'/3/0
//   Spend private/public: m/44'/145'/0'/3/1
//
// Keys are compressed pubkeys.
//
// Paycode encoding is NOT standard CashAddr: standard cashaddr's version byte
// packs size into 3 bits, capping payloads at 64 bytes — RPA's payload
// (version+prefixBits+scanPubkey(33)+spendPubkey(33)+expiry ≈ 72+ bytes)
// exceeds that. Electron Cash's cashaddr.py added encode_rpa/decode_rpa: same
// bech32-style charset + polymod checksum, but with NO version/kind byte and
// no payload-length cap. The encode/decode below independently implements the
// same no-version-byte, uncapped-length approach.

import {
  deriveHdPublicNodeChild,
  encodeCashAddress,
  sha256,
  secp256k1,
} from '@bitauth/libauth';
import { hash160 } from '@cashscript/utils';
import * as ecc from 'tiny-secp256k1';
import { Network } from '../state/slices/networkSlice';
import {
  derivePrivateKeyAtPath,
  deriveHdPublicKeyAtPath,
  getBchAddressPath,
  getBchBranchPath,
  BCH_STANDARD_BRANCH_INDEX,
} from './HdWalletService';

// ─── Key derivation paths ─────────────────────────────────────────────────────

function scanKeyPath(network: Network): string {
  return getBchAddressPath(network, 0, BCH_STANDARD_BRANCH_INDEX.rpa, 0);
}

function spendKeyPath(network: Network): string {
  return getBchAddressPath(network, 0, BCH_STANDARD_BRANCH_INDEX.rpa, 1);
}

export function getRpaKeyPaths(network: Network): { scan: string; spend: string } {
  return {
    scan: scanKeyPath(network),
    spend: spendKeyPath(network),
  };
}

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

function cashAddrPolymod(values: number[]): bigint {
  // CashAddr uses a 40-bit checksum. JavaScript's bitwise operators truncate
  // to 32 bits, so this must stay in BigInt arithmetic throughout. The former
  // Number implementation produced intermittently invalid paycodes depending
  // on the payload's high checksum bits.
  const GEN = [
    0x98f2bc8e61n,
    0x79b76d99e2n,
    0xf33e5fb3c4n,
    0xae2eabe2a8n,
    0x1e4f43e470n,
  ];
  let c = 1n;
  for (const d of values) {
    const high = c >> 35n; // top 5 bits of the 40-bit value
    c = ((c & 0x7ffffffffn) << 5n) ^ BigInt(d);
    for (let i = 0; i < 5; i++) {
      if (((high >> BigInt(i)) & 1n) === 1n) c ^= GEN[i];
    }
  }
  return c ^ 1n;
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
  for (let i = 7; i >= 0; i--) {
    checksum5.push(Number((mod >> BigInt(5 * i)) & 31n));
  }

  let body = '';
  for (const c of [...data5, ...checksum5]) body += CASHADDR_CHARSET[c];
  return `${prefix}:${body}`;
}

function cashAddrDecode(addr: string): { prefix: string; kindByte: number; payload: Uint8Array } | null {
  const bareAddress = addr.trim().split('?')[0];
  const hasLower = bareAddress !== bareAddress.toUpperCase();
  const hasUpper = bareAddress !== bareAddress.toLowerCase();
  if (hasLower && hasUpper) return null;

  const normalized = bareAddress.toLowerCase();
  const colon = normalized.indexOf(':');
  if (colon < 0) return null;
  const prefix = normalized.slice(0, colon);
  const body = normalized.slice(colon + 1);
  if (!prefix || body.length <= 8) return null;

  const data5: number[] = [];
  for (const c of body) {
    const v = CASHADDR_CHARSET_REV[c];
    if (v === undefined) return null;
    data5.push(v);
  }

  // A paycode is not a normal CashAddress payload, but it uses the same
  // prefix-expanded polymod checksum. Never accept a merely shape-correct
  // string: one changed character must fail before any sender-side work.
  if (cashAddrPolymod([...prefixExpand(prefix), ...data5]) !== 0n) return null;

  // Last 8 five-bit values are the checksum
  const payload5 = data5.slice(0, -8);
  const allBytes = fiveBitToBytes(payload5);
  if (allBytes.length < 1) return null;
  const canonicalPayload5 = bytesToFiveBit(allBytes);
  if (
    canonicalPayload5.length !== payload5.length ||
    canonicalPayload5.some((value, index) => value !== payload5[index])
  ) {
    return null;
  }

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
export async function deriveRpaKeys(
  mnemonic: string,
  passphrase: string,
  network: Network,
): Promise<RpaKeys> {
  const paths = getRpaKeyPaths(network);
  const scanPrivkey = await derivePrivateKeyAtPath(mnemonic, passphrase, paths.scan);
  const spendPrivkey = await derivePrivateKeyAtPath(mnemonic, passphrase, paths.spend);

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
    if (decoded.payload.length !== 72) return null;
    if (decoded.kindByte !== 0x00) return null;

    const p = decoded.payload;
    const isMainnetVersion = p[0] === 0x01 || p[0] === 0x02;
    const isTestnetVersion = p[0] === 0x05 || p[0] === 0x06;
    if (
      !(
        (decoded.prefix === PAYCODE_PREFIX_MAINNET && isMainnetVersion) ||
        (decoded.prefix === PAYCODE_PREFIX_TESTNET && isTestnetVersion)
      )
    ) {
      return null;
    }
    if (![0, 4, 8, 12, 16].includes(p[1])) return null;

    const scanPubkey = new Uint8Array(p.slice(2, 35));
    const spendPubkey = new Uint8Array(p.slice(35, 68));
    if (!ecc.isPoint(scanPubkey) || !ecc.isPoint(spendPubkey)) return null;

    return {
      version:    p[0],
      prefixBits: p[1],
      scanPubkey,
      spendPubkey,
      expiry: (p[68] | (p[69] << 8) | (p[70] << 16) | (p[71] << 24)) >>> 0,
    };
  } catch {
    return null;
  }
}

/**
 * Return a user-facing reason why an RPA-looking recipient must not enter the
 * ordinary CashAddress transaction builder. A complete sender implementation
 * must choose a designated input, derive the shared secret from that input's
 * private key and outpoint, and grind its signature nonce. Until that exact
 * path exists, failing closed is safer than producing an invalid or
 * privacy-degrading transaction.
 */
export function getRpaSendBlockReason(
  recipient: string,
  network: Network
): string | null {
  const bare = recipient.trim().split('?')[0].toLowerCase();
  const looksLikePaycode =
    bare.startsWith(`${PAYCODE_PREFIX_MAINNET}:`) ||
    bare.startsWith(`${PAYCODE_PREFIX_TESTNET}:`);
  if (!looksLikePaycode) return null;

  const decoded = decodePaycode(recipient);
  if (!decoded) {
    return 'This reusable payment address (RPA) is invalid. No transaction was created.';
  }

  const paycodeNetwork =
    decoded.version === 0x01 || decoded.version === 0x02
      ? Network.MAINNET
      : Network.CHIPNET;
  if (paycodeNetwork !== network) {
    const label = paycodeNetwork === Network.MAINNET ? 'Mainnet' : 'Chipnet';
    return `This RPA paycode is for ${label}, not the wallet's active network. No transaction was created.`;
  }

  return (
    'Sending to reusable payment addresses (RPA) is not available yet. ' +
    'The required designated-input derivation and signature nonce grinding are not active, so no transaction was created.'
  );
}

// Derive + encode paycode in one call (convenience wrapper).
export async function deriveAndEncodePaycode(
  mnemonic: string,
  passphrase: string,
  network: Network,
  prefixBits = RPA_PREFIX_BITS,
): Promise<string> {
  const keys = await deriveRpaKeys(mnemonic, passphrase, network);
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
//
// Scan (index 0) and spend (index 1) are unhardened children of ONE branch-3
// xpub (m/44'/145'/account'/3), so there is a single xpub to advertise here.
// PRIVACY NOTE: safe to share on its own — branch 3 is a SIBLING of
// receive(0)/change(1)/defi(7) under the account node, and CKD_pub can only
// walk downward, so holding this xpub lets a counterparty derive scan/spend
// pubkeys but not receive/change addresses, and cannot walk back up to the
// account or seed.
export async function deriveRpaGateXpub(
  mnemonic: string,
  passphrase: string,
  network: Network,
): Promise<{ rpaXpub: string; rpaPath: string }> {
  const rpaPath = getBchBranchPath(network, 0, BCH_STANDARD_BRANCH_INDEX.rpa);
  const rpaXpub = await deriveHdPublicKeyAtPath(mnemonic, passphrase, network, rpaPath);
  return { rpaXpub, rpaPath };
}
