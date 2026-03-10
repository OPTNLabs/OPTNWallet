import { describe, expect, it } from 'vitest';

import type { UTXO } from '../../../../types/types';
import { selectGenesisUtxos } from '../services';

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

describe('selectGenesisUtxos', () => {
  it('returns only vout=0 utxos without existing token data', () => {
    const utxos: UTXO[] = [
      makeUtxo({ tx_hash: '1'.repeat(64), tx_pos: 0, value: 1000 }),
      makeUtxo({ tx_hash: '2'.repeat(64), tx_pos: 1, value: 2000 }),
      makeUtxo({ tx_hash: '3'.repeat(64), tx_pos: 0, value: 1500, token: { amount: 1, category: 'cat' } }),
    ];

    const result = selectGenesisUtxos(utxos);

    expect(result).toHaveLength(1);
    expect(result[0].tx_hash).toBe('1'.repeat(64));
  });

  it('sorts eligible genesis utxos by descending value', () => {
    const utxos: UTXO[] = [
      makeUtxo({ tx_hash: '1'.repeat(64), value: 1000 }),
      makeUtxo({ tx_hash: '2'.repeat(64), value: 3000 }),
      makeUtxo({ tx_hash: '3'.repeat(64), value: 2000 }),
    ];

    const result = selectGenesisUtxos(utxos);

    expect(result.map((u) => u.tx_hash)).toEqual([
      '2'.repeat(64),
      '3'.repeat(64),
      '1'.repeat(64),
    ]);
  });

  it('handles bigint values and non-array inputs safely', () => {
    const utxos: UTXO[] = [
      makeUtxo({ tx_hash: '1'.repeat(64), value: 10 as unknown as number }),
      makeUtxo({ tx_hash: '2'.repeat(64), value: 20n as unknown as number }),
    ];

    const result = selectGenesisUtxos(utxos);
    expect(result[0].tx_hash).toBe('2'.repeat(64));

    expect(selectGenesisUtxos(null as unknown as UTXO[])).toEqual([]);
  });
});
