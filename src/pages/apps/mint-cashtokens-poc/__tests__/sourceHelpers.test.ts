import { describe, expect, it } from 'vitest';

import type { UTXO } from '../../../../types/types';
import {
  canMintFungibleFromSource,
  getMintSourceCategory,
  getMintSourceKind,
  isMintingAuthorityMintSource,
  isSelectableMintSource,
  selectMintSourceUtxos,
} from '../utils/sourceHelpers';

function makeUtxo(overrides: Partial<UTXO> = {}): UTXO {
  return {
    address: 'bitcoincash:qtest',
    height: 0,
    tx_hash: 'a'.repeat(64),
    tx_pos: 0,
    value: 546,
    ...overrides,
  } as UTXO;
}

describe('sourceHelpers', () => {
  it('classifies genesis and NFT authority sources without including fungible tokens', () => {
    const genesis = makeUtxo({ tx_hash: 'g'.repeat(64), tx_pos: 0, token: null });
    const plain = makeUtxo({
      tx_hash: 'p'.repeat(64),
      tx_pos: 2,
      token: {
        category: 'c'.repeat(64),
        amount: 0,
        nft: { capability: 'none', commitment: 'plain' },
      },
    });
    const mutable = makeUtxo({
      tx_hash: 'm'.repeat(64),
      tx_pos: 3,
      token: {
        category: 'c'.repeat(64),
        amount: 0,
        nft: { capability: 'mutable', commitment: 'mutable' },
      },
    });
    const minting = makeUtxo({
      tx_hash: 'x'.repeat(64),
      tx_pos: 4,
      token: {
        category: 'c'.repeat(64),
        amount: 0,
        nft: { capability: 'minting', commitment: 'minting' },
      },
    });
    const fungible = makeUtxo({
      tx_hash: 'f'.repeat(64),
      tx_pos: 5,
      token: {
        category: 'c'.repeat(64),
        amount: 123,
      },
    });

    expect(getMintSourceKind(genesis)).toBe('genesis');
    expect(getMintSourceKind(plain)).toBe('plain-nft');
    expect(getMintSourceKind(mutable)).toBe('mutable-nft');
    expect(getMintSourceKind(minting)).toBe('minting-nft');
    expect(getMintSourceKind(fungible)).toBe('fungible-token');

    expect(getMintSourceCategory(genesis)).toBe(genesis.tx_hash);
    expect(getMintSourceCategory(plain)).toBe('c'.repeat(64));
    expect(isSelectableMintSource(genesis)).toBe(true);
    expect(isSelectableMintSource(plain)).toBe(false);
    expect(isSelectableMintSource(mutable)).toBe(false);
    expect(isMintingAuthorityMintSource(minting)).toBe(true);
    expect(canMintFungibleFromSource(genesis)).toBe(true);
    expect(canMintFungibleFromSource(minting)).toBe(false);
    expect(isSelectableMintSource(fungible)).toBe(false);

    expect(selectMintSourceUtxos([fungible, mutable, genesis, plain, minting])).toEqual([
      genesis,
      minting,
    ]);
  });
});
