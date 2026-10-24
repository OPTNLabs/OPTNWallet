// The watch-only coin labels come from the shared Rust core through WASM.
// These run the committed binary, so a stale or missing export fails here.
import { describe, expect, it } from 'vitest';
import {
  binToHex,
  encodeTransaction,
  hash256,
  hexToBin,
} from '@bitauth/libauth';

import type { BcmrTokenMetadataState } from '../../../types/bcmr';
import type { UTXO } from '../../../types/types';
import { labelCoins, labelSpentOutput } from '../coinControlLabels';

// SeedCash pins this category as MUSD with two decimals. The metadata below is
// a fixture shaped like the desktop runtime's projection, not registry data.
const MUSD = 'b38a33f750f84c5c169a6f23cb873e6e79605021585d4f3408789689ed87f366';
const NFT_CATEGORY = 'cd'.repeat(32);

function utxo(vout: number, token?: UTXO['token']): UTXO {
  return {
    address: 'bchtest:qq',
    height: 100,
    tx_hash: 'ab'.repeat(32),
    tx_pos: vout,
    value: 1_000,
    token: token ?? null,
  };
}

function metadata(
  overrides: Partial<BcmrTokenMetadataState>
): BcmrTokenMetadataState {
  return {
    status: 'ready',
    freshness: 'fresh',
    name: 'Moria USD',
    symbol: 'MUSD',
    decimals: 2,
    iconUri: null,
    snapshot: null,
    isRefreshing: false,
    ...overrides,
  };
}

describe('labelCoins', () => {
  it('names a token coin by its verified identity and keeps it out of BCH sends', () => {
    const [bch, musd, nft] = labelCoins(
      [
        utxo(0),
        utxo(1, { category: MUSD, amount: 12_345n }),
        utxo(2, {
          category: NFT_CATEGORY,
          amount: 0,
          nft: { capability: 'minting', commitment: '01' },
        }),
      ],
      { [MUSD]: metadata({ identityStatus: 'verified' }) }
    );

    expect(bch.kind).toBe('bch');
    expect(bch.bch_send_refusal).toBeNull();

    expect(musd).toMatchObject({
      kind: 'fungible',
      title: 'MUSD',
      name: 'Moria USD',
      amount: '123.45',
      category: MUSD,
      category_short: 'b38a33f7…ed87f366',
      caveat: null,
    });
    expect(musd.bch_send_refusal).toMatch(/token-aware transfer/);

    expect(nft).toMatchObject({
      kind: 'nft',
      title: 'CashToken',
      nft_capability: 'Minting',
      amount: null,
      caveat: 'unverified',
    });
    expect(nft.bch_send_refusal).not.toBeNull();
  });

  it('does not name a coin from metadata the runtime did not authenticate', () => {
    // No identityStatus: not the wallet-scoped Rust projection.
    const [unprojected] = labelCoins(
      [utxo(0, { category: MUSD, amount: 12_345 })],
      { [MUSD]: metadata({}) }
    );
    expect(unprojected).toMatchObject({
      title: 'CashToken',
      amount: '12345',
      caveat: 'unverified',
    });

    const [stale, unpublished] = labelCoins(
      [
        utxo(0, { category: MUSD.toUpperCase(), amount: 100 }),
        utxo(1, { category: NFT_CATEGORY, amount: 7 }),
      ],
      {
        [MUSD]: metadata({ identityStatus: 'stale' }),
        [NFT_CATEGORY]: metadata({
          identityStatus: 'unpublished',
          name: NFT_CATEGORY,
          symbol: '',
          decimals: 0,
        }),
      }
    );
    expect(stale).toMatchObject({
      title: 'MUSD',
      amount: '1',
      caveat: 'last known',
    });
    expect(unpublished).toMatchObject({
      title: 'CashToken',
      caveat: 'no registry published',
    });
  });

  it('keeps a coin with unreadable token data out of BCH sends', () => {
    const [label] = labelCoins(
      [utxo(0, { category: 'not-a-category', amount: 5 })],
      {}
    );
    expect(label.kind).toBe('unreadable_tokens');
    expect(label.bch_send_refusal).not.toBeNull();
  });
});

function parentWith(token?: { category: string; amount: bigint }) {
  const bytes = encodeTransaction({
    version: 2,
    inputs: [
      {
        outpointTransactionHash: new Uint8Array(32).fill(0x31),
        outpointIndex: 0,
        unlockingBytecode: new Uint8Array(),
        sequenceNumber: 0xffffffff,
      },
    ],
    outputs: [
      {
        lockingBytecode: Uint8Array.from([
          0x76,
          0xa9,
          0x14,
          ...new Uint8Array(20).fill(0x42),
          0x88,
          0xac,
        ]),
        valueSatoshis: 1_000n,
        ...(token
          ? {
              token: {
                // libauth takes the category in display order, like a txid.
                category: hexToBin(token.category),
                amount: token.amount,
              },
            }
          : {}),
      },
    ],
    locktime: 0,
  });
  return {
    hex: binToHex(bytes),
    txid: binToHex(hash256(bytes).slice().reverse()),
  };
}

describe('labelSpentOutput', () => {
  it('reads tokens from the parent transaction itself', () => {
    const plain = parentWith();
    expect(labelSpentOutput(plain.hex, plain.txid, 0).bch_send_refusal).toBe(
      null
    );

    const tokens = parentWith({ category: MUSD, amount: 1_000n });
    const label = labelSpentOutput(tokens.hex, tokens.txid, 0);
    expect(label).toMatchObject({
      kind: 'fungible',
      category: MUSD,
      amount: '1000',
    });
    expect(label.bch_send_refusal).not.toBeNull();
  });

  it('refuses a parent that is not the named transaction', () => {
    const plain = parentWith();
    expect(() => labelSpentOutput(plain.hex, '00'.repeat(32), 0)).toThrow(
      /different transaction/
    );
    expect(() => labelSpentOutput(plain.hex, plain.txid, 1)).toThrow(
      /no output 1/
    );
  });
});
