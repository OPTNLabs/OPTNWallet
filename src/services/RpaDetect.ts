// Local RPA payment detection from a raw transaction.
//
// Fulcrum-RPA (`blockchain.reusable.get_*`) is how Electron Cash *finds*
// candidate txids. Once you already have a tx, matching is just ECDH against
// input 0 (and any other P2PKH input) — ordinary Electrum can fetch the hex.
// That is what Chipnet users need: public servers do not implement reusable.*.

import {
  binToHex,
  cashAddressToLockingBytecode,
  decodeTransaction,
  hexToBin,
} from '@bitauth/libauth';
import { Network } from '../state/slices/networkSlice';
import {
  computeSharedSecret,
  derivePaymentAddress,
  type RpaKeys,
} from './RpaService';

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

function lockingOf(address: string): Uint8Array | null {
  const locking = cashAddressToLockingBytecode(address);
  if (typeof locking === 'string') return null;
  return locking.bytecode;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function matchRpaPaymentsInRawTx(
  rawTxHex: string,
  keys: Pick<RpaKeys, 'scanPrivkey' | 'spendPubkey'>,
  network: Network
): RpaMatchedOutput[] {
  let bin: Uint8Array;
  try {
    bin = hexToBin(rawTxHex.trim());
  } catch {
    return [];
  }
  const decoded = decodeTransaction(bin);
  if (typeof decoded === 'string') return [];

  const matches: RpaMatchedOutput[] = [];
  const seen = new Set<string>();

  for (const input of decoded.inputs) {
    const pubkey = p2pkhUnlockingPubkey(input.unlockingBytecode);
    if (!pubkey) continue;
    const prevoutIndex = input.outpointIndex >>> 0;
    // The shared secret hashes the Electrum display txid, and that is exactly
    // what libauth hands back here: `Input.outpointTransactionHash` is in
    // display (big-endian) order, and encode/decode do the little-endian wire
    // reversal internally. Verified at the byte level rather than assumed --
    // encoding a transaction whose outpoint is 0123..ef writes efcd..01 to the
    // wire, and decoding returns 0123..ef again.
    //
    // This used to try the byte-reversed form as well, "in case" libauth
    // returned wire order. It never does, so that branch could not match and
    // only doubled the ECDH work per input. Do not reintroduce it: a wrong
    // txid yields a wrong secret and a wrong address, so it fails silently
    // rather than loudly.
    const prevoutHashes = [binToHex(input.outpointTransactionHash)];

    for (const prevoutHash of prevoutHashes) {
      let shared: Uint8Array;
      try {
        shared = computeSharedSecret(
          keys.scanPrivkey,
          pubkey,
          prevoutHash,
          prevoutIndex
        );
      } catch {
        continue;
      }
      const expected = derivePaymentAddress(
        keys.spendPubkey,
        shared,
        network,
        0
      );
      const expectedLock = lockingOf(expected);
      if (!expectedLock) continue;

      decoded.outputs.forEach((output, outputIndex) => {
        if (!bytesEqual(output.lockingBytecode, expectedLock)) return;
        const key = String(outputIndex);
        if (seen.has(key)) return;
        seen.add(key);
        matches.push({
          outputIndex,
          address: expected,
          valueSats: Number(output.valueSatoshis),
          prevoutHash,
          prevoutIndex,
        });
      });
    }
  }

  return matches;
}

export function normalizeRpaTxid(value: string): string | null {
  const hex = value.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) return null;
  return hex;
}
