// Build a parent transaction for a test input.
//
// Every watch-only proposal now carries PSBT_IN_NON_WITNESS_UTXO, and the
// decoder checks that the parent actually hashes to the outpoint being spent.
// That means fixtures cannot invent a txid any more — it has to be whatever
// the parent hashes to, which is what this returns.

import { binToHex, encodeTransaction, hash256 } from '@bitauth/libauth';

export interface ParentFixture {
  /** Raw parent transaction, hex. */
  hex: string;
  /** Its txid in display order — what the spending input must name. */
  txid: string;
}

/**
 * A parent transaction paying `satoshis` to `lockingBytecode` at `vout`.
 *
 * `seed` only varies the parent's own (fictional) input, which is enough to
 * give each fixture a distinct txid — useful when a test needs two different
 * coins.
 */
export function makeParentTransaction({
  lockingBytecode,
  satoshis,
  vout = 0,
  seed = 0x11,
}: {
  lockingBytecode: Uint8Array;
  satoshis: bigint;
  vout?: number;
  seed?: number;
}): ParentFixture {
  const outputs = [];
  // Filler outputs so the spent one really sits at `vout`.
  for (let index = 0; index < vout; index += 1) {
    outputs.push({ lockingBytecode: Uint8Array.of(0x6a), valueSatoshis: 546n });
  }
  outputs.push({ lockingBytecode, valueSatoshis: satoshis });

  const bytes = encodeTransaction({
    version: 2,
    inputs: [
      {
        outpointTransactionHash: new Uint8Array(32).fill(seed),
        outpointIndex: 0,
        unlockingBytecode: new Uint8Array(),
        sequenceNumber: 0xffffffff,
      },
    ],
    outputs,
    locktime: 0,
  });

  return {
    hex: binToHex(bytes),
    txid: binToHex(hash256(bytes).slice().reverse()),
  };
}
