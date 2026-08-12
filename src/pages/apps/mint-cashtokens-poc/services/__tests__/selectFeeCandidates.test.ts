import { describe, expect, it } from 'vitest';

import type { MintAppUtxo } from '../../types';
import { selectFeeCandidates } from '../selectFeeCandidates';

function makeUtxo(patch: Partial<MintAppUtxo> = {}): MintAppUtxo {
  return {
    address: 'bitcoincash:qtest',
    height: 0,
    tx_hash: 'a'.repeat(64),
    tx_pos: 1,
    value: 1000,
    token: null,
    ...patch,
  } as MintAppUtxo;
}

describe('selectFeeCandidates', () => {
  it('keeps only non-token non-genesis UTXOs and sorts by value desc', () => {
    const list = [
      makeUtxo({ tx_hash: 'g'.repeat(64), tx_pos: 0, value: 5000 }),
      makeUtxo({ tx_hash: 't'.repeat(64), tx_pos: 2, value: 3000, token: { category: 'cat', amount: 1 } }),
      makeUtxo({ tx_hash: 'f1'.padEnd(64, '1'), tx_pos: 1, value: 1000 }),
      makeUtxo({ tx_hash: 'f2'.padEnd(64, '2'), tx_pos: 3, value: 4000 }),
      makeUtxo({ tx_hash: 'f3'.padEnd(64, '3'), tx_pos: 4, value: 2000 }),
    ];

    const out = selectFeeCandidates(list);
    expect(out.map((u) => `${u.tx_hash}:${u.tx_pos}`)).toEqual([
      `${'f2'.padEnd(64, '2')}:3`,
      `${'f3'.padEnd(64, '3')}:4`,
      `${'f1'.padEnd(64, '1')}:1`,
    ]);
  });

  it('excludes keys provided in excluded set', () => {
    const a = makeUtxo({ tx_hash: 'a'.repeat(64), tx_pos: 1, value: 1000 });
    const b = makeUtxo({ tx_hash: 'b'.repeat(64), tx_pos: 2, value: 2000 });

    const out = selectFeeCandidates([a, b], new Set([`${b.tx_hash}:${b.tx_pos}`]));

    expect(out).toEqual([a]);
  });
});
