// Local RPA payment detection from a raw transaction.
//
// Fulcrum-RPA (`blockchain.reusable.get_*`) is how Electron Cash *finds*
// candidate txids. Once you already have a tx, matching is just ECDH against
// input 0 (and any other P2PKH input) — ordinary Electrum can fetch the hex.
// That is what Chipnet users need: public servers do not implement reusable.*.

import { hexToBin } from '@bitauth/libauth';
import { Network } from '../state/slices/networkSlice';
import { type RpaKeys } from './RpaService';
// Detection runs in the shared Rust core, so the CLI and the wallet cannot
// disagree about which outputs belong to a wallet.
import {
  ensureOptnCore,
  scanTransaction as coreScanTransaction,
} from '../wasm/optn-core';

/** The core takes the network as a string; this is the only mapping needed. */
function coreNetwork(network: Network): string {
  return network === Network.MAINNET ? 'mainnet' : 'chipnet';
}

export type RpaMatchedOutput = {
  outputIndex: number;
  address: string;
  valueSats: number;
  /**
   * The sender input the ECDH secret derives from, and the sender's
   * compressed pubkey on it.
   *
   * Together these are the recipe for this output's spending key. An ordinary
   * coin's key is found from its address, because the address came from a
   * known HD path; this one's cannot be, so the origin has to travel with the
   * output or the payment is detectable and unspendable. Both values are
   * public and already on chain.
   */
  prevoutHash: string;
  prevoutIndex: number;
  senderPubkey: string;
};

export function matchRpaPaymentsInRawTx(
  rawTxHex: string,
  keys: Pick<RpaKeys, 'scanPrivkey' | 'spendPubkey'>,
  network: Network
): RpaMatchedOutput[] {
  ensureOptnCore();
  let bin: Uint8Array;
  try {
    bin = hexToBin(rawTxHex.trim());
  } catch {
    return [];
  }
  try {
    // scanPrivkey and spendPubkey only. The core's signature enforces the same
    // thing, so a hot scanner can watch a wallet whose spending key never
    // leaves cold storage -- the split the spec asks for in REQ-5.
    return JSON.parse(
      coreScanTransaction(
        bin,
        keys.scanPrivkey,
        keys.spendPubkey,
        coreNetwork(network)
      )
    ) as RpaMatchedOutput[];
  } catch {
    // A transaction that will not parse is not a match, and never was.
    return [];
  }
}

export function normalizeRpaTxid(value: string): string | null {
  const hex = value.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) return null;
  return hex;
}
