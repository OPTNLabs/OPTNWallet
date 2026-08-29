// BCH Reusable Payment Address (RPA) service.
// Spec: https://github.com/imaginaryusername/Reusable_specs/blob/master/reusable_addresses.md
// Reference: Electron Cash electroncash/rpa/paycode.py.
//
// Protocol summary:
//   - Recipient shares a static "cashcode" (scan_pubkey + spend_pubkey, CashAddr
//     encoded). Legacy "paycode" strings are still accepted as send targets.
//   - Sender derives a unique one-time address via ECDH(sender_privkey, scan_pubkey) + outpoint hash
//   - Sender grinds signature nonce until input hash prefix matches scan_pubkey prefix
//   - Recipient queries an RPA-capable Electrum server (Fulcrum-RPA) using their cashcode prefix
//   - For each matching tx, recipient checks if any output belongs to them via ECDH + CKD_pub
//
// Key paths — RPA rides on the wallet's normal BIP44 account as a third
// unhardened chain, sibling to receive(0)/change(1) (see HdWalletService's
// BCH_STANDARD_BRANCH_INDEX.rpa = 3), matching the Electron Cash reference
// implementation:
//   Scan  private/public: m/44'/coinType'/0'/3/0
//   Spend private/public: m/44'/coinType'/0'/3/1
//
// Keys are compressed pubkeys throughout, including the CKD_pub child that
// becomes the one-time P2PKH. The spec is explicit — "Addresses should always
// be generated from compressed pubkeys" — and Selene's bch-rpa hashes the
// compressed child. Electron Cash's paycode.py sets `use_uncompressed = True`
// two lines under a comment saying it uses compressed keys; that is an EC bug,
// not the protocol, and we do not reproduce it.
//
// Cashcode encoding is NOT standard CashAddr: standard cashaddr's version byte
// packs size into 3 bits, capping payloads at 64 bytes — RPA's payload
// (version+prefixBits+scanPubkey(33)+spendPubkey(33)+expiry ≈ 72+ bytes)
// exceeds that. Electron Cash's cashaddr.py added encode_rpa/decode_rpa: same
// bech32-style charset + polymod checksum, but with NO version/kind byte and
// no payload-length cap. The encode/decode below independently implements the
// same no-version-byte, uncapped-length approach.

import { hexToBin, secp256k1 } from '@bitauth/libauth';
import { Network } from '../state/slices/networkSlice';
// The shared Rust core. These four primitives are the ones where a second
// implementation is most dangerous -- get any of them wrong and funds land at
// an address nobody holds a key to -- so they are delegated rather than
// reimplemented. test-vectors/rpa.json is read by this file's tests, by the
// Rust crate, and by the wasm binding, so all three must agree.
import {
  decodeCashcode as coreDecodeCashcode,
  encodeCashcode as coreEncodeCashcode,
  ensureOptnCore,
  grindString as coreGrindString,
  looksLikeRpa as coreLooksLikeRpa,
  paymentAddress as corePaymentAddress,
  sendBlockReason as coreSendBlockReason,
  sharedSecret as coreSharedSecret,
  spendingKey as coreSpendingKey,
} from '../wasm/optn-core';

/** The core takes the network as a string; this is the only mapping needed. */
function coreNetwork(network: Network): string {
  return network === Network.MAINNET ? 'mainnet' : 'chipnet';
}
import {
  derivePrivateKeyAtPath,
  deriveHdPublicKeyAtPath,
  getBchAddressPath,
  getBchBranchPath,
  BCH_STANDARD_BRANCH_INDEX,
} from './HdWalletService';

// ─── Key derivation paths ─────────────────────────────────────────────────────

function scanKeyPath(network: Network, accountPath?: string): string {
  return getBchAddressPath(network, 0, BCH_STANDARD_BRANCH_INDEX.rpa, 0, accountPath);
}

function spendKeyPath(network: Network, accountPath?: string): string {
  return getBchAddressPath(network, 0, BCH_STANDARD_BRANCH_INDEX.rpa, 1, accountPath);
}

export function getRpaKeyPaths(
  network: Network,
  accountPath?: string
): { scan: string; spend: string } {
  return {
    scan: scanKeyPath(network, accountPath),
    spend: spendKeyPath(network, accountPath),
  };
}

// ─── Paycode constants ────────────────────────────────────────────────────────

// Prefix sizes (number of bits of scan_pubkey used as Electrum filter)
// Electron Cash default prefix_size="10" (16 bits). Encoded in the paycode so
// senders grind the same width the receiver will query.
export const RPA_PREFIX_BITS = 16;

/** Fulcrum-RPA / EC grind string: hex of scan pubkey after the 02/03 byte. */
export function rpaGrindString(
  scanPubkey: Uint8Array,
  prefixBits = RPA_PREFIX_BITS
): string {
  ensureOptnCore();
  return coreGrindString(scanPubkey, prefixBits);
}

// CashAddr prefixes.
//
// `cashcode:` / `cashcodetest:` are what this wallet EMITS. The legacy
// `paycode:` / `paycodetest:` prefixes (Electron Cash networks.py RPA_PREFIX)
// stay ACCEPTED on input, so codes people already handed out keep working —
// we simply never generate one.
export const CASHCODE_PREFIX_MAINNET = 'cashcode';
export const CASHCODE_PREFIX_TESTNET = 'cashcodetest';
export const LEGACY_PAYCODE_PREFIX_MAINNET = 'paycode';
export const LEGACY_PAYCODE_PREFIX_TESTNET = 'paycodetest';

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
  /** The CashAddr prefix the string actually carried. */
  prefix: string;
  /** True when decoded from a legacy `paycode:` / `paycodetest:` string. */
  legacy: boolean;
};

// Derive all four RPA key materials from a mnemonic.
export async function deriveRpaKeys(
  mnemonic: string,
  passphrase: string,
  network: Network,
  accountPath?: string,
): Promise<RpaKeys> {
  const paths = getRpaKeyPaths(network, accountPath);
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

/**
 * Which prefix family to stamp on an encoded code.
 *
 * The wallet only ever emits `cashcode`. `legacy-paycode` exists so tests and
 * migration tooling can construct the old form we must keep accepting; no
 * production call site passes it.
 */
export type RpaPrefixFamily = 'cashcode' | 'legacy-paycode';

// Encode scan_pubkey + spend_pubkey as a CashAddr cashcode string.
// prefixBits: how many bits of scan_pubkey to use as Electrum filter (8 = 1/256 bandwidth).
export function encodePaycode(
  scanPubkey: Uint8Array,
  spendPubkey: Uint8Array,
  network: Network,
  prefixBits = RPA_PREFIX_BITS,
  prefixFamily: RpaPrefixFamily = 'cashcode'
): string {
  ensureOptnCore();
  return coreEncodeCashcode(
    scanPubkey,
    spendPubkey,
    coreNetwork(network),
    prefixBits,
    prefixFamily === 'legacy-paycode'
  );
}

// Parse a paycode string back to its components.
export function decodePaycode(paycodeStr: string): DecodedPaycode | null {
  ensureOptnCore();
  try {
    // The core throws with the reason a code was rejected. This function's
    // contract is null-or-value, and every caller already treats null as
    // "not a usable code", so the reason is dropped here --
    // getRpaSendBlockReason is where a user-facing reason comes from.
    const decoded = JSON.parse(coreDecodeCashcode(paycodeStr)) as {
      version: number;
      prefixBits: number;
      scanPubkey: string;
      spendPubkey: string;
      expiry: number;
      prefix: string;
      legacy: boolean;
    };
    return {
      version: decoded.version,
      prefixBits: decoded.prefixBits,
      scanPubkey: hexToBin(decoded.scanPubkey),
      spendPubkey: hexToBin(decoded.spendPubkey),
      expiry: decoded.expiry,
      prefix: decoded.prefix,
      legacy: decoded.legacy,
    };
  } catch {
    return null;
  }
}

export function looksLikeRpaPaycode(recipient: string): boolean {
  ensureOptnCore();
  return coreLooksLikeRpa(recipient);
}

/**
 * Block only invalid / wrong-network paycodes. A valid paycode is sent
 * through finalizeRpaPayment (dummy dest → ECDH dest → prefix grind).
 */
export function getRpaSendBlockReason(
  recipient: string,
  network: Network
): string | null {
  if (!looksLikeRpaPaycode(recipient)) return null;

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

  // Expiry stays here rather than in the core: it depends on the current time,
  // and the core is pure.
  if (decoded.expiry !== 0) {
    const oneWeek = Math.floor(Date.now() / 1000) + 604_800;
    if (decoded.expiry < oneWeek) {
      return 'This paycode has expired. No transaction was created.';
    }
  }

  // Offline-only versions and prefix-0 codes: one rule, decided in the core so
  // the CLI cannot drift from it.
  const coreReason = coreSendBlockReason(recipient);
  if (coreReason) return `${coreReason}. No transaction was created.`;

  return null;
}

// Derive + encode paycode in one call (convenience wrapper).
export async function deriveAndEncodePaycode(
  mnemonic: string,
  passphrase: string,
  network: Network,
  prefixBits = RPA_PREFIX_BITS,
  accountPath?: string,
): Promise<string> {
  const keys = await deriveRpaKeys(mnemonic, passphrase, network, accountPath);
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
  vout: number
): Uint8Array {
  ensureOptnCore();
  // `txid` is the display (big-endian) form, as Electrum reports it.
  return coreSharedSecret(privkey, counterpartPubkey, txid, vout);
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
  index = 0
): string {
  ensureOptnCore();
  return corePaymentAddress(spendPubkey, sharedSecret, coreNetwork(network), index);
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
  index = 0
): Promise<Uint8Array> {
  ensureOptnCore();
  return coreSpendingKey(spendPrivkey, sharedSecret, index);
}

// ─── XPub gate derivation (for WizardConnect extension advertisement) ─────────
//
// Scan (index 0) and spend (index 1) are unhardened children of ONE branch-3
// xpub (m/44'/coinType'/account'/3), so there is a single xpub to advertise here.
// PRIVACY NOTE: safe to share on its own — branch 3 is a SIBLING of
// receive(0)/change(1)/defi(7) under the account node, and CKD_pub can only
// walk downward, so holding this xpub lets a counterparty derive scan/spend
// pubkeys but not receive/change addresses, and cannot walk back up to the
// account or seed.
export async function deriveRpaGateXpub(
  mnemonic: string,
  passphrase: string,
  network: Network,
  accountPath?: string,
): Promise<{ rpaXpub: string; rpaPath: string }> {
  const rpaPath = getBchBranchPath(
    network,
    0,
    BCH_STANDARD_BRANCH_INDEX.rpa,
    accountPath
  );
  const rpaXpub = await deriveHdPublicKeyAtPath(mnemonic, passphrase, network, rpaPath);
  return { rpaXpub, rpaPath };
}
