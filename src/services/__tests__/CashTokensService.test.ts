import { describe, expect, it } from 'vitest';

import type { UTXO } from '../../types/types';
import {
  buildCapabilityEligibility,
  buildMintPlan,
  buildMutationPlan,
  summarizeTokenFamilies,
  validateNftCapabilityTransition,
} from '../cashtokens';

function makeUtxo(overrides: Partial<UTXO> = {}): UTXO {
  return {
    address: 'bchtest:qtest',
    height: 0,
    tx_hash: 'a'.repeat(64),
    tx_pos: 0,
    value: 546,
    amount: 546,
    ...overrides,
  } as UTXO;
}

describe('CashTokens service', () => {
  it('summarizes categories by NFT capability and fungible holdings', () => {
    const category = '11'.repeat(32);
    const summary = summarizeTokenFamilies([
      makeUtxo({
        tx_hash: 'aa'.repeat(32),
        token: {
          category,
          amount: 10,
        },
      }),
      makeUtxo({
        tx_hash: 'bb'.repeat(32),
        token: {
          category,
          amount: 0,
          nft: { capability: 'none', commitment: '01' },
        },
      }),
      makeUtxo({
        tx_hash: 'cc'.repeat(32),
        token: {
          category,
          amount: 0,
          nft: { capability: 'mutable', commitment: '02' },
        },
      }),
      makeUtxo({
        tx_hash: 'dd'.repeat(32),
        token: {
          category,
          amount: 0,
          nft: { capability: 'minting', commitment: '03' },
        },
      }),
    ]);

    expect(summary).toHaveLength(1);
    expect(summary[0]).toMatchObject({
      category,
      tokenUtxoCount: 4,
      fungibleUtxoCount: 1,
      nftUtxoCount: 3,
      plainNftUtxoCount: 1,
      mutableNftUtxoCount: 1,
      mintingNftUtxoCount: 1,
      capabilities: ['minting', 'mutable', 'none'],
    });
  });

  it('treats a plain NFT family as Quantumroot-compatible and a mutable family as authority-only', () => {
    const family = {
      category: '22'.repeat(32),
      totalAtomicAmount: 0n,
      tokenUtxoCount: 1,
      fungibleUtxoCount: 0,
      nftUtxoCount: 1,
      plainNftUtxoCount: 1,
      mutableNftUtxoCount: 0,
      mintingNftUtxoCount: 0,
      capabilities: ['none' as const],
    };
    expect(buildCapabilityEligibility(family, 'none')).toMatchObject({
      hasRequestedCapability: true,
      canUseForQuantumroot: true,
      blockers: [],
    });

    const mutableFamily = {
      ...family,
      plainNftUtxoCount: 0,
      mutableNftUtxoCount: 1,
      capabilities: ['mutable' as const],
    };
    expect(buildCapabilityEligibility(mutableFamily, 'none')).toMatchObject({
      hasRequestedCapability: false,
      canUseForQuantumroot: false,
    });
  });

  it('allows multiple NFT outputs from genesis but rejects duplicate outputs from a plain NFT source', () => {
    const genesis = makeUtxo({ tx_hash: 'g'.repeat(64), tx_pos: 0, token: null });
    const plainNft = makeUtxo({
      tx_hash: 'p'.repeat(64),
      tx_pos: 1,
      token: {
        category: 'p'.repeat(64),
        amount: 0,
        nft: { capability: 'none', commitment: 'seed' },
      },
    });

    expect(
      buildMintPlan({
        sourceByKey: new Map([
          ['g:0', genesis],
          ['p:1', plainNft],
        ]),
        outputs: [
          {
            id: 'n1',
            sourceKey: 'g:0',
            recipientAddress: 'bchtest:q1',
            kind: 'nft',
            nftCapability: 'none',
            nftCommitment: '01',
          },
          {
            id: 'n2',
            sourceKey: 'g:0',
            recipientAddress: 'bchtest:q2',
            kind: 'nft',
            nftCapability: 'none',
            nftCommitment: '02',
          },
        ],
      }).ready
    ).toBe(true);

    const rejected = buildMintPlan({
      sourceByKey: new Map([['p:1', plainNft]]),
      outputs: [
        {
          id: 'n1',
          sourceKey: 'p:1',
          recipientAddress: 'bchtest:q1',
          kind: 'nft',
          nftCapability: 'none',
          nftCommitment: 'seed',
        },
        {
          id: 'n2',
          sourceKey: 'p:1',
          recipientAddress: 'bchtest:q2',
          kind: 'nft',
          nftCapability: 'none',
          nftCommitment: 'seed',
        },
      ],
    });

    expect(rejected.ready).toBe(false);
    expect(rejected.blockers[0]).toContain('plain NFT source');
  });

  it('rejects mutable outputs that try to mint more than one NFT', () => {
    const mutable = makeUtxo({
      tx_hash: 'm'.repeat(64),
      tx_pos: 1,
      token: {
        category: 'm'.repeat(64),
        amount: 0,
        nft: { capability: 'mutable', commitment: 'seed' },
      },
    });

    expect(
      validateNftCapabilityTransition({
        sourceCapability: 'mutable',
        sourceCommitment: 'seed',
        requestedCapability: 'none',
        requestedCommitment: 'next',
        outputCount: 2,
      })
    ).toMatchObject({
      ok: false,
    });

    expect(
      buildMutationPlan({
        source: mutable,
        sourceKey: 'm:1',
        requestedCapability: 'minting',
        outputCount: 1,
        requestedCommitment: 'next',
      }).ready
    ).toBe(false);
  });
});
