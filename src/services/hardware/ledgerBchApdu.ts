/**
 * Ledger Bitcoin Cash APDUs — a call-through to the shared Rust core.
 *
 * Ledger deprecated the LedgerJS family in September 2026 and points everyone
 * at the Device Management Kit, which ships a signer kit per chain and none
 * for Bitcoin Cash. The Bitcoin one cannot stand in: its descriptor templates
 * are `pkh`, `sh(wpkh(..))`, `wpkh` and `tr` — the wallet-policy protocol the
 * Bitcoin Cash device app does not speak. `hw-app-btc` itself routed
 * `currency: 'bch'` to its *legacy* implementation for that reason.
 *
 * So the app-binder is ours to write, and it is written once, in
 * `crates/optn-core/src/ledger.rs`. This file used to hold a second copy in
 * TypeScript. Two encoders for one device protocol is two things that can
 * disagree about which address a path holds, and the disagreement is silent:
 * a wrong P2 still returns an address, on the same chain, that no Bitcoin Cash
 * wallet displays. Nothing errors until funds are already there.
 *
 * The exported surface is unchanged, so callers did not move. What changed is
 * that these functions no longer decide anything — the bytes come from the
 * same Rust the CLI and the desktop shell use.
 */

import {
  ensureOptnCore,
  ledgerAddressFormat,
  ledgerEncodeBip32Path,
  ledgerGetWalletPublicKey,
  ledgerParseWalletPublicKey,
  ledgerStatusWord,
} from '../../wasm/optn-core';

/** Bitcoin application class byte. */
export const CLA_BTC = 0xe0;
/** GET WALLET PUBLIC KEY. */
export const INS_GET_WALLET_PUBLIC_KEY = 0x40;

/**
 * Address encodings the app can return, read from the core rather than
 * restated here.
 *
 * `cashaddr` is 3, and it is the only one this wallet asks for: a Ledger
 * handed a BCH path and asked for the app default will happily produce a
 * legacy address, which is an address on the same chain that no modern
 * Bitcoin Cash wallet shows.
 */
export const ADDRESS_FORMAT = {
  get legacy() {
    ensureOptnCore();
    return ledgerAddressFormat('legacy');
  },
  get p2sh() {
    ensureOptnCore();
    return ledgerAddressFormat('p2sh');
  },
  get bech32() {
    ensureOptnCore();
    return ledgerAddressFormat('bech32');
  },
  get cashaddr() {
    ensureOptnCore();
    return ledgerAddressFormat('cashaddr');
  },
} as const;

export type AddressFormat = 'legacy' | 'p2sh' | 'bech32' | 'cashaddr';

export interface Apdu {
  cla: number;
  ins: number;
  p1: number;
  p2: number;
  data: Uint8Array;
}

export interface WalletPublicKey {
  /** Uncompressed public key, hex. */
  publicKey: string;
  /** The address the device rendered, in the format that was asked for. */
  address: string;
  /** BIP32 chain code, hex. */
  chainCode: string;
}

const fromHex = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
};

/**
 * Encode a BIP32 path the way the Bitcoin app expects: a count byte, then one
 * big-endian u32 per level, hardened levels having the high bit set.
 */
export function encodeBip32Path(path: string): Uint8Array {
  ensureOptnCore();
  return ledgerEncodeBip32Path(path);
}

/**
 * Build the GET WALLET PUBLIC KEY command.
 *
 * `verify` asks the device to show the address on its own screen, which is the
 * only way a holder can tell the address on the computer is the one the device
 * derived.
 */
export function buildGetWalletPublicKey(
  path: string,
  options: { verify?: boolean; format?: AddressFormat } = {}
): Apdu {
  ensureOptnCore();
  const { verify = false, format = 'cashaddr' } = options;
  const built = JSON.parse(
    ledgerGetWalletPublicKey(path, verify, format)
  ) as Omit<Apdu, 'data'> & { data: string };
  return { ...built, data: fromHex(built.data) };
}

/**
 * Read the device's reply: a length-prefixed public key, a length-prefixed
 * ASCII address, then 32 bytes of chain code. Every length is checked in the
 * core against what actually arrived, so a truncated reply throws rather than
 * yielding a short address.
 */
export function parseWalletPublicKey(response: Uint8Array): WalletPublicKey {
  ensureOptnCore();
  return JSON.parse(ledgerParseWalletPublicKey(response)) as WalletPublicKey;
}

/**
 * Turn a status word into something a holder can act on. `null` is success.
 */
export function describeStatusWord(status: number): string | null {
  ensureOptnCore();
  return ledgerStatusWord(status) || null;
}
