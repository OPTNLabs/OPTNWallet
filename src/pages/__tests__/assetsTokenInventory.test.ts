import { describe, expect, it } from 'vitest';
import type { UTXO } from '../../types/types';
import {
  buildNftCardModels,
  buildNftParseInfo,
  dedupeTokenUtxos,
  describeNftCapability,
  getStableTokenUtxos,
  summarizeNftInstances,
} from '../assetsTokenInventory';
import type { NftCategory } from '@bitauth/libauth';

function tokenUtxo(
  txHash: string,
  txPos: number,
  category: string,
  amount: number
): UTXO {
  return {
    address: 'bitcoincash:q1',
    height: 1,
    tx_hash: txHash,
    tx_pos: txPos,
    value: 1000,
    amount: 1000,
    token: {
      category,
      amount,
    },
  };
}

function nftTokenUtxo(
  txHash: string,
  txPos: number,
  category: string,
  commitment: string
): UTXO {
  return {
    address: 'bitcoincash:q1',
    height: 1,
    tx_hash: txHash,
    tx_pos: txPos,
    value: 1000,
    amount: 1000,
    token: {
      category,
      amount: 0,
      nft: {
        capability: 'none',
        commitment,
      },
    },
  };
}

describe('assetsTokenInventory', () => {
  it('dedupes token utxos by outpoint', () => {
    const rows = [
      tokenUtxo('a'.repeat(64), 0, 'cat-a', 1),
      tokenUtxo('a'.repeat(64), 0, 'cat-b', 2),
      tokenUtxo('b'.repeat(64), 1, 'cat-c', 3),
      {
        address: 'bitcoincash:q1',
        height: 1,
        tx_hash: 'c'.repeat(64),
        tx_pos: 2,
        value: 1000,
        amount: 1000,
      } as UTXO,
    ];

    expect(dedupeTokenUtxos(rows)).toEqual([
      tokenUtxo('a'.repeat(64), 0, 'cat-b', 2),
      tokenUtxo('b'.repeat(64), 1, 'cat-c', 3),
    ]);
  });

  it('returns the first non-empty token snapshot from the available sources', () => {
    const fallback = [tokenUtxo('b'.repeat(64), 1, 'cat-b', 4)];
    const redux = [tokenUtxo('c'.repeat(64), 2, 'cat-c', 5)];

    expect(getStableTokenUtxos([], fallback, redux)).toEqual(fallback);
    expect(getStableTokenUtxos([], [], redux)).toEqual(redux);
    expect(getStableTokenUtxos([], [], [])).toEqual([]);
  });

  it('summarizes NFT instances individually even when the category matches', () => {
    const category = 'ff'.repeat(32);
    const instances = summarizeNftInstances([
      nftTokenUtxo('a'.repeat(64), 0, category, 'commitment-a'),
      nftTokenUtxo('b'.repeat(64), 1, category, 'commitment-b'),
      nftTokenUtxo('a'.repeat(64), 0, category, 'commitment-overwrite'),
    ]);

    expect(instances).toHaveLength(2);
    expect(instances[0]).toMatchObject({
      outpoint: `${'a'.repeat(64)}:0`,
      category,
      capability: 'none',
      commitment: 'commitment-overwrite',
    });
    expect(instances[1]).toMatchObject({
      outpoint: `${'b'.repeat(64)}:1`,
      category,
      capability: 'none',
      commitment: 'commitment-b',
    });
  });
});

describe('buildNftParseInfo', () => {
  const PLEDGE_NFTS: NftCategory = {
    description: 'Pledge receipts.',
    fields: {
      pledgeValue: {
        name: 'Pledge Value',
        encoding: {
          type: 'number',
          aggregate: 'add',
          decimals: 8,
          unit: 'BCH',
        },
      },
    },
    parse: {
      bytecode: '006b00cf6b',
      types: {
        '': {
          name: 'Pledge Receipt',
          description: 'A crowdfunding pledge.',
          fields: ['pledgeValue'],
        },
      },
    },
  };

  it('maps a parsable NftCategory into NftParseInfo', () => {
    const info = buildNftParseInfo(PLEDGE_NFTS);
    expect(info).not.toBeNull();
    expect(info?.bytecode).toBe('006b00cf6b');
    expect(info?.types[''].name).toBe('Pledge Receipt');
    expect(info?.types[''].fields).toEqual(['pledgeValue']);
    expect(info?.fields?.pledgeValue.encoding).toMatchObject({
      type: 'number',
      decimals: 8,
      unit: 'BCH',
    });
  });

  it('maps a sequential NftCategory without bytecode', () => {
    const info = buildNftParseInfo({
      parse: { types: { '8000': { name: '#128' } } },
    } as NftCategory);
    expect(info?.bytecode).toBe('');
    expect(info?.types['8000'].name).toBe('#128');
    expect(info?.fields).toBeUndefined();
  });

  it('returns null for missing metadata', () => {
    expect(buildNftParseInfo(undefined)).toBeNull();
  });

  it('describes capabilities', () => {
    expect(describeNftCapability('none')).toBe('Plain NFT');
    expect(describeNftCapability('mutable')).toBe('Mutable NFT');
    expect(describeNftCapability('minting')).toBe('Minting NFT');
  });
});

describe('buildNftCardModels', () => {
  const category = 'ff'.repeat(32);

  function instancesFor(...commitments: string[]) {
    return commitments.map((commitment, index) => ({
      outpoint: `${index}:0`,
      txHash: String(index).repeat(64),
      txPos: 0,
      category,
      capability: 'none' as const,
      commitment,
      utxo: nftTokenUtxo(String(index).repeat(64), 0, category, commitment),
    }));
  }

  it('parses parsable NFT commitments into typed cards', () => {
    const cards = buildNftCardModels(
      instancesFor('00e1f505'),
      {
        [category]: {
          symbol: 'CFC2023XAMPL',
          nfts: {
            description: 'Pledge receipts.',
            fields: {
              pledgeValue: {
                name: 'Pledge Value',
                encoding: {
                  type: 'number',
                  aggregate: 'add',
                  decimals: 8,
                  unit: 'BCH',
                },
              },
            },
            parse: {
              bytecode: '006b00cf6b',
              types: {
                '': { name: 'Pledge Receipt', fields: ['pledgeValue'] },
              },
            },
          },
        },
      }
    );

    expect(cards).toHaveLength(1);
    const card = cards[0];
    expect(card.parsed).toBe(true);
    expect(card.primaryLabel).toBe('Pledge Receipt');
    expect(card.ticker).toBe('CFC2023XAMPL-100000000');
    expect(card.fields).toHaveLength(1);
    expect(card.fields[0]?.parsedValue).toMatchObject({
      type: 'number',
      value: 100_000_000n,
      formatted: '1 BCH',
    });
  });

  it('matches sequential commitments to sequential types', () => {
    const cards = buildNftCardModels(instancesFor('8000'), {
      [category]: {
        symbol: 'EXMPLS',
        nfts: {
          parse: { types: { '8000': { name: '#128' } } },
        } as NftCategory,
      },
    });

    expect(cards[0]?.parsed).toBe(true);
    expect(cards[0]?.primaryLabel).toBe('#128');
    expect(cards[0]?.ticker).toBe('EXMPLS-128');
  });

  it('falls back to X-prefixed ticker for unknown sequential commitments', () => {
    const cards = buildNftCardModels(instancesFor('ff'), {
      [category]: {
        symbol: 'EXMPLS',
        nfts: {
          parse: { types: { '8000': { name: '#128' } } },
        } as NftCategory,
      },
    });

    expect(cards[0]?.parsed).toBe(false);
    expect(cards[0]?.primaryLabel).toBe('EXMPLS-XFF');
    expect(cards[0]?.parseError).toContain('No NFT type definition');
  });

  it('renders hex commitment as ticker without metadata', () => {
    const cards = buildNftCardModels(instancesFor('012a'), {});

    expect(cards[0]?.parsed).toBe(false);
    expect(cards[0]?.ticker).toBe('0x012a');
    expect(cards[0]?.secondaryLabel).toContain('Plain NFT');
    expect(cards[0]?.secondaryLabel).toContain('012a');
  });
});
