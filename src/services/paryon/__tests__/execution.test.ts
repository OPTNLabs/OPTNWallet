import { describe, expect, it } from 'vitest';

import { resolveParyonWorkspaceSnapshot } from '../ParyonService';
import { buildParyonExecutionPlans } from '../execution';
import type { ParyonNativeSnapshot } from '../native';

const snapshot = resolveParyonWorkspaceSnapshot('mainnet');

function makeNativeSnapshot(overrides?: Partial<ParyonNativeSnapshot>): ParyonNativeSnapshot {
  const base: ParyonNativeSnapshot = {
    balances: {
      bchSats: 0n,
      pusdAtomic: 0n,
      spendableUtxoCount: 0,
      tokenUtxoCount: 0,
    },
    market: {
      oraclePriceCentsPerBch: 50_000n,
      currentPeriod: 10,
      currentEpoch: 1,
      chainHeight: 948_406 + 1_440,
      expectedPeriod: 10,
      periodDeltaPeriods: 0,
      writeEnabled: true,
      verifiedMainnetV1: true,
    },
    liveContracts: {
      PriceContract: {
        name: 'PriceContract',
        address: 'price',
        tokenId: 'price-token',
        resolved: true,
        utxoCount: 1,
        totalValueSats: 1_000n,
        latestCommitment: '00002710',
        latestTokenAmount: 0n,
        latestCapability: 'mutable',
        preferredOutpoint: 'price:0',
        threadCount: 1,
        freshness: 'fresh',
        warnings: [],
      },
      Borrowing: {
        name: 'Borrowing',
        address: 'borrowing',
        tokenId: 'borrow-token',
        resolved: true,
        utxoCount: 1,
        totalValueSats: 1_000n,
        latestCommitment: '00000000',
        latestTokenAmount: 0n,
        latestCapability: 'minting',
        preferredOutpoint: 'borrowing:0',
        threadCount: 1,
        freshness: 'fresh',
        warnings: [],
      },
      StabilityPool: {
        name: 'StabilityPool',
        address: 'pool',
        tokenId: 'pool-token',
        resolved: true,
        utxoCount: 1,
        totalValueSats: 1_000n,
        latestCommitment: '0000000a00000000000a000000000014',
        latestTokenAmount: 0n,
        latestCapability: 'minting',
        preferredOutpoint: 'pool:0',
        threadCount: 1,
        freshness: 'fresh',
        warnings: [],
      },
      Redeemer: {
        name: 'Redeemer',
        address: 'redeemer',
        tokenId: 'redeemer-token',
        resolved: true,
        utxoCount: 1,
        totalValueSats: 1_000n,
        latestCommitment: '00000000',
        latestTokenAmount: 0n,
        latestCapability: 'minting',
        preferredOutpoint: 'redeemer:0',
        threadCount: 1,
        freshness: 'fresh',
        warnings: [],
      },
      LoanKeyFactory: {
        name: 'LoanKeyFactory',
        address: 'factory',
        tokenId: 'factory-token',
        resolved: true,
        utxoCount: 1,
        totalValueSats: 1_000n,
        latestCommitment: '00000000',
        latestTokenAmount: 0n,
        latestCapability: 'minting',
        preferredOutpoint: 'factory:0',
        threadCount: 1,
        freshness: 'fresh',
        warnings: [],
      },
    },
    positions: {
      loans: 1,
      stakes: 1,
      redemptions: 1,
    },
    positionIndex: {
      loans: [
        {
          kind: 'loan',
          positionId: 'loan:1',
          txHash: 'loan',
          outputIndexes: [0, 1],
          contractNames: ['Loan', 'LoanSidecar'],
          tokenCategories: ['token'],
          tokenAmountAtomic: 100n,
          valueSats: 1_000n,
          capability: 'minting',
          state: 'live',
          label: 'Loan bundle',
          details: ['loan'],
          warnings: [],
        },
      ],
      stabilityPool: [
        {
          kind: 'stability-pool',
          positionId: 'pool:1',
          txHash: 'pool',
          outputIndexes: [0, 1],
          contractNames: ['StabilityPool', 'StabilityPoolSidecar'],
          tokenCategories: ['token'],
          tokenAmountAtomic: 100n,
          valueSats: 1_000n,
          capability: 'minting',
          state: 'live',
          label: 'Stability pool bundle',
          details: ['pool'],
          warnings: [],
        },
      ],
      redemptions: [
        {
          kind: 'redemption',
          positionId: 'redeem:1',
          txHash: 'redeem',
          outputIndexes: [0, 1],
          contractNames: ['Redemption', 'RedemptionSidecar'],
          tokenCategories: ['token'],
          tokenAmountAtomic: 100n,
          valueSats: 1_000n,
          capability: 'minting',
          state: 'live',
          label: 'Redemption bundle',
          details: ['redeem'],
          warnings: [],
        },
      ],
      authorities: [],
      system: [],
      summary: {
        loans: 1,
        stabilityPool: 1,
        redemptions: 1,
        authorities: 0,
        system: 0,
        total: 3,
      },
    },
    threadHealth: [
      {
        name: 'PriceContract',
        tokenId: 'price-token',
        preferredOutpoint: 'price:0',
        threadCount: 1,
        freshness: 'fresh',
        warnings: [],
      },
      {
        name: 'Borrowing',
        tokenId: 'borrow-token',
        preferredOutpoint: 'borrowing:0',
        threadCount: 1,
        freshness: 'fresh',
        warnings: [],
      },
      {
        name: 'StabilityPool',
        tokenId: 'pool-token',
        preferredOutpoint: 'pool:0',
        threadCount: 1,
        freshness: 'fresh',
        warnings: [],
      },
      {
        name: 'Redeemer',
        tokenId: 'redeemer-token',
        preferredOutpoint: 'redeemer:0',
        threadCount: 1,
        freshness: 'fresh',
        warnings: [],
      },
      {
        name: 'LoanKeyFactory',
        tokenId: 'factory-token',
        preferredOutpoint: 'factory:0',
        threadCount: 1,
        freshness: 'fresh',
        warnings: [],
      },
    ],
    systemHealth: {
      chainHeight: 948_406 + 1_440,
      expectedPeriod: 10,
      periodDeltaPeriods: 0,
      canWrite: true,
      freshThreads: 5,
      degradedThreads: 0,
      staleThreads: 0,
    },
    flowPlans: {
      loan: {
        key: 'loan',
        title: 'Loan lifecycle',
        summary: '',
        ready: true,
        blockedReason: null,
        warnings: [],
        subplans: [],
      },
      pool: {
        key: 'pool',
        title: 'Stability pool lifecycle',
        summary: '',
        ready: true,
        blockedReason: null,
        warnings: [],
        subplans: [],
      },
      redemption: {
        key: 'redemption',
        title: 'Redemption lifecycle',
        summary: '',
        ready: true,
        blockedReason: null,
        warnings: [],
        subplans: [],
      },
      operator: {
        key: 'operator',
        title: 'Operator and maintenance',
        summary: '',
        ready: true,
        blockedReason: null,
        warnings: [],
        subplans: [],
      },
    },
    walletUtxos: [],
    tokenUtxos: [],
    warnings: [],
    loadedAt: 0,
  };

  return {
    ...base,
    ...overrides,
  };
}

describe('Paryon execution plans', () => {
  it('selects live positions and documents transaction output shapes', () => {
    const plans = buildParyonExecutionPlans({
      snapshot: {
        readiness: snapshot.readiness,
        verifiedMainnetV1: snapshot.verifiedMainnetV1,
      },
      market: {
        writeEnabled: true,
        currentEpoch: 1,
        periodDeltaPeriods: 0,
      },
      nativeSnapshot: makeNativeSnapshot(),
    });

    expect(plans.borrow.ready).toBe(true);
    expect(plans.manageLoan.target?.kind).toBe('loan');
    expect(plans.withdraw.target?.kind).toBe('stability-pool');
    expect(plans.redeem.target?.kind).toBe('redemption');
    expect(plans.borrow.outputTemplate).toContain('Borrowed PUSD output');
    expect(plans.redeem.validation).toContain('Finalization delay is 12 blocks');
  });

  it('fails closed when write mode is not available', () => {
    const plans = buildParyonExecutionPlans({
      snapshot: {
        readiness: 'missing-config',
        verifiedMainnetV1: false,
      },
      market: {
        writeEnabled: false,
        currentEpoch: null,
        periodDeltaPeriods: null,
      },
      nativeSnapshot: makeNativeSnapshot({
        systemHealth: {
          chainHeight: null,
          expectedPeriod: null,
          periodDeltaPeriods: null,
          canWrite: false,
          freshThreads: 0,
          degradedThreads: 0,
          staleThreads: 5,
        },
      }),
    });

    expect(plans.borrow.ready).toBe(false);
    expect(plans.borrow.blockedReason).toBe('Deployment config is missing.');
  });
});
