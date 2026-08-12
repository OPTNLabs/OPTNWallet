// Which outputs of a completed fusion belong to us — the input to fuse-depth.
//
// A CoinJoin carries every participant's outputs, so depth accounting has to
// pick out our own. It matches on LOCKING SCRIPT rather than output index: the
// round shuffles outputs precisely so position reveals nothing, and a caller
// guessing indices would silently mark a peer's coin as ours the first time the
// ordering changed.
//
// The scripts come from the caller because both transports already hold them
// authoritatively — P2P from `createFreshFusionOutputScripts`, server Fusion
// from its allocation — which is more reliable than re-deriving ownership from
// wallet state that may not have been persisted yet.

import { decodeTransaction } from '@bitauth/libauth';

import { binToHex, hexToBin } from '../../utils/hex';

/**
 * `txid:index` for every output of `txHex` paying one of `ownedScripts`.
 *
 * Duplicate scripts are handled naturally: a round may legitimately give us two
 * outputs, and both are returned because matching is per output, not per script.
 */
export function ownedOutpointsOf(
  txHex: string,
  txid: string,
  ownedScripts: readonly string[]
): string[] {
  if (ownedScripts.length === 0) return [];
  const decoded = decodeTransaction(hexToBin(txHex));
  if (typeof decoded === 'string') return [];

  const wanted = new Set(ownedScripts.map((script) => script.toLowerCase()));
  const mine: string[] = [];
  decoded.outputs.forEach((output, index) => {
    if (wanted.has(binToHex(output.lockingBytecode).toLowerCase())) {
      mine.push(`${txid}:${index}`);
    }
  });
  return mine;
}

/** `txid:index` for the coins a fusion consumed on our behalf. */
export function spentOutpointsOf(
  spentInputs: readonly { tx_hash: string; tx_pos: number }[]
): string[] {
  return spentInputs.map((utxo) => `${utxo.tx_hash}:${utxo.tx_pos}`);
}
