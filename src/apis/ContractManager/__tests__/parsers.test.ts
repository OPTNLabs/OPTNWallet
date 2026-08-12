import { describe, expect, it } from 'vitest';

import type { SqlRow } from '../types';
import { parseContractInstanceRow } from '../parsers';

describe('ContractManager/parsers', () => {
  it('parseContractInstanceRow parses persisted fields into runtime shape', () => {
    const row: SqlRow = {
      id: '7',
      contract_name: 'Escrow',
      address: 'bitcoincash:qcontract',
      token_address: 'simpleledger:qtoken',
      balance: '12345',
      utxos: JSON.stringify([
        {
          tx_hash: 'a'.repeat(64),
          tx_pos: '1',
          height: '100',
          amount: '546',
          token: { category: 'cat', amount: 1 },
          prefix: 'bitcoincash',
          contractFunction: 'claim',
          contractFunctionInputs: JSON.stringify({ amount: 1 }),
        },
      ]),
      artifact: JSON.stringify({ contractName: 'Escrow', abi: [] }),
      abi: JSON.stringify([{ name: 'claim', inputs: [] }]),
      redeemScript: JSON.stringify('76a9...88ac'),
      unlock: JSON.stringify({ fn: '(x) => x + 2' }),
      updated_at: '2026-02-28T00:00:00.000Z',
    };

    const parsed = parseContractInstanceRow(row);

    expect(parsed.id).toBe(7);
    expect(parsed.contract_name).toBe('Escrow');
    expect(parsed.balance).toBe(12345n);

    expect(parsed.utxos).toHaveLength(1);
    expect(parsed.utxos[0].tx_pos).toBe(1);
    expect(parsed.utxos[0].height).toBe(100);
    expect(parsed.utxos[0].amount).toBe(546n);
    expect(parsed.utxos[0].contractFunctionInputs).toEqual({ amount: 1 });

    expect(parsed.abi[0].name).toBe('claim');
    expect(parsed.artifact.contractName).toBe('Escrow');
    expect(parsed.redeemScript).toBe('76a9...88ac');

    expect(typeof parsed.unlock?.fn).toBe('function');
    if (parsed.unlock?.fn && typeof parsed.unlock.fn === 'function') {
      expect((parsed.unlock.fn as (x: number) => number)(40)).toBe(42);
    }
  });

  it('parseContractInstanceRow uses defaults for malformed rows', () => {
    const parsed = parseContractInstanceRow({
      id: undefined,
      contract_name: undefined,
      address: undefined,
      token_address: undefined,
      balance: undefined,
      utxos: '{bad',
      artifact: '{bad',
      abi: '{bad',
      unlock: 123,
    });

    expect(parsed.id).toBe(0);
    expect(parsed.contract_name).toBe('');
    expect(parsed.address).toBe('');
    expect(parsed.token_address).toBe('');
    expect(parsed.balance).toBe(0n);
    expect(parsed.utxos).toEqual([]);
    expect(parsed.abi).toEqual([]);
    expect(parsed.unlock).toBeNull();
  });
});
