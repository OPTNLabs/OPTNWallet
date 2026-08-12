import { describe, expect, it } from 'vitest';

import type { UTXO } from '../../types/types';
import {
  summarizeQuantumrootWalletTokenInventory,
  type QuantumrootWalletTokenSummary,
} from '../QuantumrootWalletTokenInventoryService';

function makeTokenUtxo(
  txHash: string,
  txPos: number,
  category: string,
  amount: number,
  capability: 'none' | 'mutable' | 'minting' | null = null
): UTXO {
  return {
    address: 'bchtest:token',
    value: 546,
    amount: 546,
    height: 0,
    tx_hash: txHash,
    tx_pos: txPos,
    token: capability
      ? {
          category,
          amount,
          nft: {
            capability,
            commitment: '',
          },
        }
      : {
          category,
          amount,
        },
  };
}

function byCategory(
  summaries: QuantumrootWalletTokenSummary[]
): Record<string, QuantumrootWalletTokenSummary> {
  return Object.fromEntries(summaries.map((summary) => [summary.category, summary]));
}

describe('QuantumrootWalletTokenInventoryService', () => {
  it('deduplicates token outpoints and groups holdings by category', () => {
    const categoryA = '11'.repeat(32);
    const categoryB = '22'.repeat(32);
    const categoryC = '33'.repeat(32);

    const summaries = summarizeQuantumrootWalletTokenInventory([
      makeTokenUtxo('aa', 0, categoryA, 10),
      makeTokenUtxo('aa', 0, categoryA, 99),
      makeTokenUtxo('bb', 1, categoryA, 5),
      makeTokenUtxo('cc', 2, categoryB, 0, 'none'),
      makeTokenUtxo('dd', 3, categoryC, 0, 'mutable'),
      makeTokenUtxo('ee', 4, categoryC, 0, 'minting'),
    ]);

    expect(summaries).toHaveLength(2);
    expect(summaries[0].category).toBe(categoryB);
    expect(summaries[1].category).toBe(categoryC);

    const grouped = byCategory(summaries);
    expect(grouped[categoryB]).toMatchObject({
      category: categoryB,
      tokenUtxoCount: 1,
      nftUtxoCount: 1,
      plainNftUtxoCount: 1,
      mutableNftUtxoCount: 0,
      mintingNftUtxoCount: 0,
    });
    expect(grouped[categoryB].totalAtomicAmount).toBe(0n);
    expect(grouped[categoryC]).toMatchObject({
      category: categoryC,
      tokenUtxoCount: 2,
      nftUtxoCount: 2,
      plainNftUtxoCount: 0,
      mutableNftUtxoCount: 1,
      mintingNftUtxoCount: 1,
    });
  });
});
