import { describe, expect, it } from 'vitest';

import {
  bucketQuantumrootReceiveUtxos,
  summarizeQuantumrootVaultStatus,
} from '../QuantumrootVaultStatusService';
import type { UTXO } from '../../types/types';

function makeUtxo(address: string, value: number, txPos: number): UTXO {
  return {
    address,
    value,
    amount: value,
    height: 0,
    tx_hash: `tx-${address}-${txPos}`,
    tx_pos: txPos,
  };
}

describe('QuantumrootVaultStatusService', () => {
  it('summarizes receive and quantum lock balances separately and in total', () => {
    const status = summarizeQuantumrootVaultStatus(
      [makeUtxo('recv', 1200, 0), makeUtxo('recv', 3400, 1)],
      [makeUtxo('lock', 800, 0)]
    );

    expect(status.receiveBalanceSats).toBe(4600);
    expect(status.receiveUtxoCount).toBe(2);
    expect(status.quantumLockBalanceSats).toBe(800);
    expect(status.quantumLockUtxoCount).toBe(1);
    expect(status.totalBalanceSats).toBe(5400);
    expect(status.totalUtxoCount).toBe(3);
    expect(status.isFunded).toBe(true);
  });

  it('reports an unfunded vault when both address sets are empty', () => {
    const status = summarizeQuantumrootVaultStatus([], []);

    expect(status.receiveBalanceSats).toBe(0);
    expect(status.quantumLockBalanceSats).toBe(0);
    expect(status.totalBalanceSats).toBe(0);
    expect(status.totalUtxoCount).toBe(0);
    expect(status.isFunded).toBe(false);
  });

  it('separates recoverable BCH receive UTXOs from unsupported token receive UTXOs', () => {
    const buckets = bucketQuantumrootReceiveUtxos([
      makeUtxo('recv', 1_500, 0),
      makeUtxo('recv', 546, 1),
      {
        ...makeUtxo('recv', 2_000, 2),
        token: {
          amount: 1,
          category: '11'.repeat(32),
        },
      },
    ]);

    expect(buckets.recoverableReceiveUtxos).toHaveLength(1);
    expect(buckets.recoverableReceiveUtxos[0].tx_pos).toBe(0);
    expect(buckets.unsupportedReceiveUtxos).toHaveLength(1);
    expect(buckets.unsupportedReceiveUtxos[0].tx_pos).toBe(2);
  });
});
