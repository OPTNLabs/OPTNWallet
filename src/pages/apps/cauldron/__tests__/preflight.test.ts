import { binToHex } from '@bitauth/libauth';
import { describe, expect, it } from 'vitest';

import type {
  CauldronPool,
  CauldronWalletPoolPosition,
} from '../../../../services/cauldron';
import {
  buildCauldronPoolV0LockingBytecode,
  normalizeCauldronPoolRow,
} from '../../../../services/cauldron';
import type { UTXO } from '../../../../types/types';
import {
  assertWalletInputsStillAvailable,
  fetchCurrentQuotedPoolsFromChain,
  fetchVisiblePoolsFromChain,
  getPoolSelectionId,
  resolveCurrentPoolForReview,
} from '../preflight';

function makeUtxo(overrides?: Partial<UTXO>): UTXO {
  return {
    address: 'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a',
    tx_hash: '11'.repeat(32),
    tx_pos: 0,
    value: 1000,
    amount: 1000,
    height: 0,
    token: null,
    ...overrides,
  };
}

function makePool(overrides?: Partial<CauldronPool>): CauldronPool {
  const withdrawPublicKeyHash = new Uint8Array(20);
  return {
    version: '0',
    txHash: 'aa'.repeat(32),
    outputIndex: 0,
    poolId: null,
    ownerAddress: null,
    ownerPublicKeyHash: null,
    parameters: {
      withdrawPublicKeyHash,
    },
    output: {
      amountSatoshis: 1000n,
      tokenCategory: 'bb'.repeat(32),
      tokenAmount: 500n,
      lockingBytecode: buildCauldronPoolV0LockingBytecode({
        withdrawPublicKeyHash,
      }),
    },
    ...overrides,
  };
}

function makePosition(pool: CauldronPool): CauldronWalletPoolPosition {
  return {
    pool,
    ownerAddress: null,
    matchingNftUtxos: [],
    hasMatchingTokenNft: false,
    detectionSource: 'owner_pkh',
  };
}

describe('cauldron preflight helpers', () => {
  it('accepts reviewed wallet inputs when all selected outpoints are still spendable', () => {
    const reviewedInputs = [
      makeUtxo({ tx_hash: '01'.repeat(32), tx_pos: 1 }),
      makeUtxo({ tx_hash: '02'.repeat(32), tx_pos: 2 }),
    ];
    const currentWalletUtxos = [
      reviewedInputs[0],
      reviewedInputs[1],
      makeUtxo({ tx_hash: '03'.repeat(32), tx_pos: 3 }),
    ];

    expect(() =>
      assertWalletInputsStillAvailable(
        currentWalletUtxos,
        reviewedInputs,
        'Cauldron pool creation'
      )
    ).not.toThrow();
  });

  it('rejects reviewed wallet inputs when a selected outpoint is no longer spendable', () => {
    const reviewedInputs = [
      makeUtxo({ tx_hash: '01'.repeat(32), tx_pos: 1 }),
      makeUtxo({ tx_hash: '02'.repeat(32), tx_pos: 2 }),
    ];
    const currentWalletUtxos = [reviewedInputs[0]];

    expect(() =>
      assertWalletInputsStillAvailable(
        currentWalletUtxos,
        reviewedInputs,
        'Cauldron pool withdrawal'
      )
    ).toThrow(
      'Cauldron pool withdrawal needs refreshed wallet inputs. One or more selected UTXOs are no longer spendable.'
    );
  });

  it('prefers the latest detected pool when review data is stale but selection id matches', () => {
    const withdrawPublicKeyHash = new Uint8Array(20);
    const reviewedPool = makePool({
      txHash: '10'.repeat(32),
      outputIndex: 1,
      parameters: {
        withdrawPublicKeyHash,
      },
      output: {
        amountSatoshis: 1000n,
        tokenCategory: 'cc'.repeat(32),
        tokenAmount: 500n,
        lockingBytecode: buildCauldronPoolV0LockingBytecode({
          withdrawPublicKeyHash,
        }),
      },
    });
    const latestPool = makePool({
      txHash: reviewedPool.txHash,
      outputIndex: reviewedPool.outputIndex,
      output: {
        amountSatoshis: 1200n,
        tokenCategory: reviewedPool.output.tokenCategory,
        tokenAmount: 450n,
        lockingBytecode: buildCauldronPoolV0LockingBytecode({
          withdrawPublicKeyHash,
        }),
      },
    });

    const resolved = resolveCurrentPoolForReview(reviewedPool, [
      makePosition(latestPool),
    ]);

    expect(getPoolSelectionId(resolved)).toBe(getPoolSelectionId(reviewedPool));
    expect(resolved.output.amountSatoshis).toBe(1200n);
    expect(resolved.output.tokenAmount).toBe(450n);
  });

  it('falls back to the reviewed pool when no newer detected position exists', () => {
    const reviewedPool = makePool({
      txHash: '10'.repeat(32),
      outputIndex: 1,
    });

    const resolved = resolveCurrentPoolForReview(reviewedPool, []);

    expect(resolved).toBe(reviewedPool);
  });

  it('resolves quoted pools from chain-backed rows before swap submission', async () => {
    const withdrawPublicKeyHash = new Uint8Array(20);
    const reviewedPool = makePool({
      txHash: '10'.repeat(32),
      outputIndex: 1,
      parameters: {
        withdrawPublicKeyHash,
      },
      output: {
        amountSatoshis: 1000n,
        tokenCategory: 'cc'.repeat(32),
        tokenAmount: 500n,
        lockingBytecode: buildCauldronPoolV0LockingBytecode({
          withdrawPublicKeyHash,
        }),
      },
    });
    const onChainPool = makePool({
      txHash: reviewedPool.txHash,
      outputIndex: reviewedPool.outputIndex,
      output: {
        amountSatoshis: 1200n,
        tokenCategory: reviewedPool.output.tokenCategory,
        tokenAmount: 450n,
        lockingBytecode: reviewedPool.output.lockingBytecode,
      },
    });

    const sdk = {
      chain: {
        queryUnspentByLockingBytecode: async () => ({
          data: {
            output: [
              {
                txid: onChainPool.txHash,
                tx_pos: onChainPool.outputIndex,
                sats: Number(onChainPool.output.amountSatoshis),
                token_id: onChainPool.output.tokenCategory,
                tokens: onChainPool.output.tokenAmount.toString(),
                owner_pkh: '00'.repeat(20),
                locking_bytecode: binToHex(onChainPool.output.lockingBytecode),
              },
            ],
          },
        }),
      },
    };

    const resolved = await fetchCurrentQuotedPoolsFromChain({
      sdk: sdk as any,
      quotedPools: [reviewedPool],
    });

    expect(resolved.missingQuotedPoolCount).toBe(0);
    expect(resolved.resolvedPools).toHaveLength(1);
    expect(resolved.resolvedPools[0]).toEqual(onChainPool);
  });

  it('reports quoted pools that are no longer present on chain', async () => {
    const reviewedPool = makePool({
      txHash: '10'.repeat(32),
      outputIndex: 1,
    });

    const sdk = {
      chain: {
        queryUnspentByLockingBytecode: async () => ({
          data: {
            output: [],
          },
        }),
      },
    };

    const resolved = await fetchCurrentQuotedPoolsFromChain({
      sdk: sdk as any,
      quotedPools: [reviewedPool],
    });

    expect(resolved.missingQuotedPoolCount).toBe(1);
    expect(resolved.resolvedPools).toEqual([]);
  });

  it('filters visible pools down to exact chain-confirmed outpoints for quoting', async () => {
    const withdrawPublicKeyHash = new Uint8Array(20);
    const confirmedPool = makePool({
      txHash: '21'.repeat(32),
      outputIndex: 0,
      parameters: {
        withdrawPublicKeyHash,
      },
      output: {
        amountSatoshis: 1500n,
        tokenCategory: 'cc'.repeat(32),
        tokenAmount: 700n,
        lockingBytecode: buildCauldronPoolV0LockingBytecode({
          withdrawPublicKeyHash,
        }),
      },
    });
    const stalePool = makePool({
      txHash: '22'.repeat(32),
      outputIndex: 1,
      output: {
        amountSatoshis: 1700n,
        tokenCategory: confirmedPool.output.tokenCategory,
        tokenAmount: 800n,
        lockingBytecode: confirmedPool.output.lockingBytecode,
      },
    });

    const sdk = {
      chain: {
        queryUnspentByLockingBytecode: async () => ({
          data: {
            output: [
              {
                txid: confirmedPool.txHash,
                tx_pos: confirmedPool.outputIndex,
              },
            ],
          },
        }),
      },
    };

    const resolved = await fetchVisiblePoolsFromChain({
      sdk: sdk as any,
      visiblePools: [confirmedPool, stalePool],
    });

    expect(resolved.missingVisiblePoolCount).toBe(1);
    expect(resolved.confirmedPools).toEqual([confirmedPool]);
  });

  it('matches Chaingraph pool rows by transaction_hash and output_index', async () => {
    const withdrawPublicKeyHash = new Uint8Array(20);
    const confirmedPool = makePool({
      txHash: '24'.repeat(32),
      outputIndex: 2,
      parameters: {
        withdrawPublicKeyHash,
      },
      output: {
        amountSatoshis: 2100n,
        tokenCategory: 'dd'.repeat(32),
        tokenAmount: 900n,
        lockingBytecode: buildCauldronPoolV0LockingBytecode({
          withdrawPublicKeyHash,
        }),
      },
    });

    const sdk = {
      chain: {
        queryUnspentByLockingBytecode: async () => ({
          data: {
            output: [
              {
                transaction_hash: `\\x${confirmedPool.txHash}`,
                output_index: confirmedPool.outputIndex,
              },
            ],
          },
        }),
      },
    };

    const resolved = await fetchVisiblePoolsFromChain({
      sdk: sdk as any,
      visiblePools: [confirmedPool],
    });

    expect(resolved.missingVisiblePoolCount).toBe(0);
    expect(resolved.confirmedPools).toEqual([confirmedPool]);
  });

  it('preserves pool history identifiers when normalizing active pool rows', () => {
    const withdrawPublicKeyHash = new Uint8Array(20);
    const reviewedPool = makePool({
      txHash: '51'.repeat(32),
      outputIndex: 4,
      parameters: {
        withdrawPublicKeyHash,
      },
      output: {
        amountSatoshis: 2200n,
        tokenCategory: 'aa'.repeat(32),
        tokenAmount: 900n,
        lockingBytecode: buildCauldronPoolV0LockingBytecode({
          withdrawPublicKeyHash,
        }),
      },
    });

    const normalized = normalizeCauldronPoolRow({
      txid: reviewedPool.txHash,
      tx_pos: reviewedPool.outputIndex,
      sats: Number(reviewedPool.output.amountSatoshis),
      tokens: reviewedPool.output.tokenAmount.toString(),
      token_id: reviewedPool.output.tokenCategory,
      owner_pkh: '00'.repeat(20),
      owner_p2pkh_addr: 'bitcoincash:qqqexample',
      pool_id: 'pool-12345',
      locking_bytecode: binToHex(reviewedPool.output.lockingBytecode),
    });

    expect(normalized?.poolId).toBe('pool-12345');
    expect(normalized?.output.tokenCategory).toBe(reviewedPool.output.tokenCategory);
    expect(normalized?.output.tokenAmount).toBe(reviewedPool.output.tokenAmount);
  });

  it('rehydrates visible pools from exact chain row reserves before quoting', async () => {
    const withdrawPublicKeyHash = new Uint8Array(20);
    const reviewedPool = makePool({
      txHash: '31'.repeat(32),
      outputIndex: 1,
      parameters: {
        withdrawPublicKeyHash,
      },
      output: {
        amountSatoshis: 1800n,
        tokenCategory: 'ee'.repeat(32),
        tokenAmount: 700n,
        lockingBytecode: buildCauldronPoolV0LockingBytecode({
          withdrawPublicKeyHash,
        }),
      },
    });

    const sdk = {
      chain: {
        queryUnspentByLockingBytecode: async () => ({
          data: {
            output: [
              {
                transaction_hash: reviewedPool.txHash,
                output_index: reviewedPool.outputIndex,
                value_satoshis: '2500',
                fungible_token_amount: '640',
                token_category: reviewedPool.output.tokenCategory,
                locking_bytecode: binToHex(reviewedPool.output.lockingBytecode),
              },
            ],
          },
        }),
      },
    };

    const resolved = await fetchVisiblePoolsFromChain({
      sdk: sdk as any,
      visiblePools: [reviewedPool],
    });

    expect(resolved.missingVisiblePoolCount).toBe(0);
    expect(resolved.confirmedPools).toHaveLength(1);
    expect(resolved.confirmedPools[0]?.output.amountSatoshis).toBe(2500n);
    expect(resolved.confirmedPools[0]?.output.tokenAmount).toBe(640n);
  });

  it('rehydrates visible pools when Chaingraph uses camelCase locking bytecode fields', async () => {
    const withdrawPublicKeyHash = new Uint8Array(20);
    const reviewedPool = makePool({
      txHash: '41'.repeat(32),
      outputIndex: 3,
      parameters: {
        withdrawPublicKeyHash,
      },
      output: {
        amountSatoshis: 1900n,
        tokenCategory: 'ff'.repeat(32),
        tokenAmount: 800n,
        lockingBytecode: buildCauldronPoolV0LockingBytecode({
          withdrawPublicKeyHash,
        }),
      },
    });

    const sdk = {
      chain: {
        queryUnspentByLockingBytecode: async () => ({
          data: {
            output: [
              {
                txid: reviewedPool.txHash,
                vout: reviewedPool.outputIndex,
                value: '1900',
                amount: '1900',
                token_id: reviewedPool.output.tokenCategory,
                tokenAmount: '800',
                lockingBytecode: binToHex(reviewedPool.output.lockingBytecode),
              },
            ],
          },
        }),
      },
    };

    const resolved = await fetchVisiblePoolsFromChain({
      sdk: sdk as any,
      visiblePools: [reviewedPool],
    });

    expect(resolved.missingVisiblePoolCount).toBe(0);
    expect(resolved.confirmedPools).toHaveLength(1);
    expect(resolved.confirmedPools[0]?.output.amountSatoshis).toBe(1900n);
    expect(resolved.confirmedPools[0]?.output.tokenAmount).toBe(800n);
  });

  it('reports when no visible pools remain confirmed on chain', async () => {
    const visiblePool = makePool({
      txHash: '23'.repeat(32),
      outputIndex: 0,
    });

    const sdk = {
      chain: {
        queryUnspentByLockingBytecode: async () => ({
          data: {
            output: [],
          },
        }),
      },
    };

    const resolved = await fetchVisiblePoolsFromChain({
      sdk: sdk as any,
      visiblePools: [visiblePool],
    });

    expect(resolved.missingVisiblePoolCount).toBe(1);
    expect(resolved.confirmedPools).toEqual([]);
  });
});
