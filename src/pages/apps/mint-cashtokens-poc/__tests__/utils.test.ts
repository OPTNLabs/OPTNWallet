import { describe, expect, it } from 'vitest';

import type { TransactionOutput, UTXO } from '../../../../types/types';
import type { MintOutputDraft } from '../types';
import {
  asTxSummaryInputs,
  asTxSummaryOutputs,
  filterActiveOutputDrafts,
  mergeWalletUtxos,
  shortHash,
  sumOutputs,
  toBigIntSafe,
  utxoKey,
  utxoValue,
  validateCategoryReuseRules,
} from '../utils';

function makeUtxo(overrides: Partial<UTXO> = {}): UTXO {
  return {
    address: 'bitcoincash:qtestaddress',
    height: 0,
    tx_hash: 'a'.repeat(64),
    tx_pos: 0,
    value: 546,
    ...overrides,
  };
}

function makeDraft(overrides: Partial<MintOutputDraft> = {}): MintOutputDraft {
  return {
    id: 'draft-1',
    recipientCashAddr: 'bitcoincash:qrecipient',
    sourceKey: `${'a'.repeat(64)}:0`,
    config: {
      mintType: 'FT',
      ftAmount: '1',
      nftCapability: 'none',
      nftCommitment: '',
    },
    ...overrides,
  };
}

describe('mint-cashtokens-poc/utils', () => {
  it('builds utxo keys from tx hash and vout', () => {
    const utxo = makeUtxo({ tx_hash: 'abc123', tx_pos: 2 });
    expect(utxoKey(utxo)).toBe('abc123:2');
  });

  it('shortHash shortens long hashes and preserves short ones', () => {
    const long = '1234567890abcdef1234567890abcdef';
    expect(shortHash(long, 4, 4)).toBe('1234…cdef');
    expect(shortHash('short')).toBe('short');
    expect(shortHash('')).toBe('');
  });

  it('utxoValue handles value, amount, bigint, and invalid values', () => {
    expect(utxoValue({ value: 10 })).toBe(10n);
    expect(utxoValue({ amount: '20' })).toBe(20n);
    expect(utxoValue({ value: 30n })).toBe(30n);
    expect(utxoValue({ value: 'not-a-number' })).toBe(0n);
    expect(utxoValue(undefined)).toBe(0n);
  });

  it('toBigIntSafe parses trimmed values and safely handles invalid values', () => {
    expect(toBigIntSafe(' 42 ')).toBe(42n);
    expect(toBigIntSafe('')).toBe(0n);
    expect(toBigIntSafe('abc')).toBe(0n);
  });

  it('sumOutputs adds standard outputs and skips OP_RETURN or invalid amounts', () => {
    const outputs: TransactionOutput[] = [
      { recipientAddress: 'bitcoincash:q1', amount: 1000 },
      { recipientAddress: 'bitcoincash:q2', amount: 2000n },
      { opReturn: ['6d02', 'test'] },
      { recipientAddress: 'bitcoincash:q3', amount: 'invalid' as unknown as number },
    ];

    expect(sumOutputs(outputs)).toBe(3000n);
  });

  it('mergeWalletUtxos combines all lists and de-duplicates by tx hash + vout', () => {
    const shared = makeUtxo({ tx_hash: 'z'.repeat(64), tx_pos: 1, value: 1000 });
    const unique = makeUtxo({ tx_hash: 'y'.repeat(64), tx_pos: 0, value: 2000 });

    const result = mergeWalletUtxos({
      allUtxos: [shared],
      tokenUtxos: [shared],
      cashTokenUtxos: [unique],
    });

    expect(result).toHaveLength(2);
    expect(result.map((u) => `${u.tx_hash}:${u.tx_pos}`)).toEqual([
      `${shared.tx_hash}:${shared.tx_pos}`,
      `${unique.tx_hash}:${unique.tx_pos}`,
    ]);
  });

  it('filterActiveOutputDrafts keeps only drafts with selected recipient and source', () => {
    const a = makeDraft({ id: 'a', recipientCashAddr: 'r1', sourceKey: 's1' });
    const b = makeDraft({ id: 'b', recipientCashAddr: 'r1', sourceKey: 's2' });
    const c = makeDraft({ id: 'c', recipientCashAddr: 'r2', sourceKey: 's1' });

    const filtered = filterActiveOutputDrafts(
      [a, b, c],
      new Set(['r1']),
      new Set(['s1'])
    );

    expect(filtered).toEqual([a]);
  });

  it('validateCategoryReuseRules allows duplicated category only when all are FT', () => {
    const categoryTxHash = 'b'.repeat(64);
    const sourceByKey = new Map<string, UTXO>([
      ['s1', makeUtxo({ tx_hash: categoryTxHash, tx_pos: 0 })],
      ['s2', makeUtxo({ tx_hash: categoryTxHash, tx_pos: 1 })],
    ]);

    const okResult = validateCategoryReuseRules(
      [
        makeDraft({ id: '1', sourceKey: 's1', config: { ...makeDraft().config, mintType: 'FT' } }),
        makeDraft({ id: '2', sourceKey: 's2', config: { ...makeDraft().config, mintType: 'FT' } }),
      ],
      sourceByKey
    );

    expect(okResult).toEqual({ ok: true });

    const badResult = validateCategoryReuseRules(
      [
        makeDraft({ id: '1', sourceKey: 's1', config: { ...makeDraft().config, mintType: 'FT' } }),
        makeDraft({ id: '2', sourceKey: 's2', config: { ...makeDraft().config, mintType: 'NFT' } }),
      ],
      sourceByKey
    );

    expect(badResult.ok).toBe(false);
    if (!badResult.ok && 'message' in badResult) {
      expect(badResult.message).toContain('Category');
      expect(badResult.message).toContain('must be FT');
    }
  });

  it('asTxSummaryInputs maps selected utxos to summary format', () => {
    const inputs = asTxSummaryInputs([
      makeUtxo({ tx_hash: 'tx1', tx_pos: 0, value: 700, token: null }),
      makeUtxo({ tx_hash: 'tx2', tx_pos: 1, value: 800, amount: 123, token: { amount: 1, category: 'cat' } }),
    ]);

    expect(inputs).toEqual([
      { txid: 'tx1', vout: 0, sats: 700, token: false },
      { txid: 'tx2', vout: 1, sats: 800, token: true },
    ]);
  });

  it('asTxSummaryOutputs maps regular and OP_RETURN outputs', () => {
    const outputs: TransactionOutput[] = [
      { recipientAddress: 'bitcoincash:q1', amount: 1000 },
      { opReturn: ['6d02', 'hello'] },
      { recipientAddress: 'bitcoincash:q2', amount: 546, token: { amount: 1, category: 'cat' } },
    ];

    expect(asTxSummaryOutputs(outputs)).toEqual([
      { index: 0, address: 'bitcoincash:q1', sats: 1000, kind: 'bch' },
      { index: 1, address: 'OP_RETURN', sats: 0, kind: 'bch' },
      { index: 2, address: 'bitcoincash:q2', sats: 546, kind: 'token' },
    ]);
    expect(asTxSummaryOutputs(undefined)).toEqual([]);
  });
});
