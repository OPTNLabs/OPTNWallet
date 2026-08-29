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
import { ensureOptnCore, scanTransaction as coreScanTransaction } from '../wasm/optn-core';

/** The core takes the network as a string; this is the only mapping needed. */
function coreNetwork(network: Network): string {
  return network === Network.MAINNET ? 'mainnet' : 'chipnet';
}

export type RpaMatchedOutput = {
  outputIndex: number;
  address: string;
  valueSats: number;
  prevoutHash: string;
  prevoutIndex: number;
};

export function p2pkhUnlockingPubkey(
  unlocking: Uint8Array
): Uint8Array | null {
  const pushes = readMinimalPushes(unlocking);
  if (!pushes || pushes.length === 0) return null;
  const last = pushes[pushes.length - 1];
  if (last.length !== 33) return null;
  if (last[0] !== 0x02 && last[0] !== 0x03) return null;
  return last;
}

function readMinimalPushes(script: Uint8Array): Uint8Array[] | null {
  const pushes: Uint8Array[] = [];
  let i = 0;
  while (i < script.length) {
    const op = script[i];
    i += 1;
    let n = 0;
    if (op > 0 && op <= 75) {
      n = op;
    } else if (op === 0x4c) {
      if (i >= script.length) return null;
      n = script[i];
      i += 1;
    } else if (op === 0x4d) {
      if (i + 1 >= script.length) return null;
      n = script[i] | (script[i + 1] << 8);
      i += 2;
    } else {
      return null;
    }
    if (i + n > script.length) return null;
    pushes.push(script.slice(i, i + n));
    i += n;
  }
  return pushes;
}

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
      coreScanTransaction(bin, keys.scanPrivkey, keys.spendPubkey, coreNetwork(network))
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
