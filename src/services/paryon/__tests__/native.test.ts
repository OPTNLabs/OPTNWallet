import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveParyonWorkspaceSnapshot } from '../ParyonService';
import type { AddonSDK } from '../../AddonsSDK';
import {
  buildBorrowPreview,
  buildRedeemPreview,
  buildStakePreview,
  loadParyonNativeSnapshot,
  paryonNativeViewReducer,
  type ParyonLiveMarketState,
} from '../native';

const verifiedSnapshot = resolveParyonWorkspaceSnapshot('mainnet');

const liveMarket: ParyonLiveMarketState = {
  oraclePriceCentsPerBch: 50_000n,
  currentPeriod: 10,
  currentEpoch: 1,
  chainHeight: 100,
  expectedPeriod: 10,
  periodDeltaPeriods: 0,
  writeEnabled: true,
  verifiedMainnetV1: true,
};

describe('Paryon native workflow', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('navigates between dashboard and action views', () => {
    expect(paryonNativeViewReducer('dashboard', { type: 'navigate', view: 'borrow' })).toBe(
      'borrow'
    );
    expect(paryonNativeViewReducer('borrow', { type: 'back' })).toBe('dashboard');
    expect(paryonNativeViewReducer('stats', { type: 'home' })).toBe('dashboard');
  });

  it('builds a borrow preview and rejects missing collateral', () => {
    const preview = buildBorrowPreview({
      snapshot: verifiedSnapshot,
      market: liveMarket,
      borrowAmountText: '150.00',
      collateralBchText: '0.40',
    });

    expect(preview.action).toBe('borrow');
    expect(preview.canProceed).toBe(true);
    expect(preview.primaryMetricValue).toBe('0.33 BCH');
    expect(preview.details).toContain('Launch-phase borrow flow keeps the native wallet in charge of confirmations.');

    const invalid = buildBorrowPreview({
      snapshot: verifiedSnapshot,
      market: liveMarket,
      borrowAmountText: '150.00',
      collateralBchText: '',
    });

    expect(invalid.canProceed).toBe(false);
    expect(invalid.warnings).toContain('Enter a valid BCH collateral amount.');
  });

  it('builds a stake preview and blocks sub-minimum amounts', () => {
    const preview = buildStakePreview({
      snapshot: verifiedSnapshot,
      market: liveMarket,
      stakeAmountText: '100.00',
    });

    expect(preview.action).toBe('stake');
    expect(preview.canProceed).toBe(true);
    expect(preview.primaryMetricValue).toBe('2');

    const invalid = buildStakePreview({
      snapshot: verifiedSnapshot,
      market: liveMarket,
      stakeAmountText: '99.99',
    });

    expect(invalid.canProceed).toBe(false);
    expect(invalid.warnings).toContain('Stake minimum is 100.00 PUSD.');
  });

  it('builds a redeem preview with locked-in payout estimates', () => {
    const preview = buildRedeemPreview({
      snapshot: verifiedSnapshot,
      market: liveMarket,
      redeemAmountText: '100.00',
    });

    expect(preview.action).toBe('redeem');
    expect(preview.canProceed).toBe(true);
    expect(preview.primaryMetricLabel).toBe('Estimated BCH payout');
    expect(preview.secondaryMetricValue).toBe('12 blocks');
    expect(preview.details).toContain('The wallet keeps the redemption flow fully native.');
  });

  it('loads wallet balances and live contract state from chain queries', async () => {
    const sdk = {
      wallet: {
        getContext: () => ({ walletId: 1, network: 'mainnet' }),
      },
      utxos: {
        listForWallet: vi.fn().mockResolvedValue({
          allUtxos: [
            {
              tx_hash: 'bch',
              tx_pos: 0,
              value: 123_456_789,
            },
            {
              tx_hash: 'pusd',
              tx_pos: 1,
              value: 1_000,
              token: {
                category: verifiedSnapshot.config.tokenIds.paryonTokenId,
                amount: 2_500,
              },
            },
            {
              tx_hash: 'loan',
              tx_pos: 2,
              value: 1_000,
              contractName: 'Loan',
            },
            {
              tx_hash: 'loan',
              tx_pos: 3,
              value: 1_000,
              contractName: 'LoanSidecar',
            },
            {
              tx_hash: 'pool',
              tx_pos: 4,
              value: 1_000,
              contractName: 'StabilityPool',
            },
            {
              tx_hash: 'pool',
              tx_pos: 5,
              value: 1_000,
              contractName: 'StabilityPoolSidecar',
            },
            {
              tx_hash: 'redeem',
              tx_pos: 6,
              value: 1_000,
              contractName: 'Redemption',
            },
            {
              tx_hash: 'redeem',
              tx_pos: 7,
              value: 1_000,
              contractName: 'RedemptionSidecar',
            },
            {
              tx_hash: 'authority',
              tx_pos: 8,
              value: 1_000,
              contractName: 'LoanKeyFactory',
            },
            {
              tx_hash: 'authority',
              tx_pos: 9,
              value: 1_000,
              contractName: 'LoanKeyOriginProof',
            },
          ],
          tokenUtxos: [
            {
              tx_hash: 'pusd',
              tx_pos: 1,
              value: 1_000,
              token: {
                category: verifiedSnapshot.config.tokenIds.paryonTokenId,
                amount: 2_500,
              },
            },
          ],
        }),
      },
      chain: {
        getLatestBlock: vi.fn().mockResolvedValue({
          height: verifiedSnapshot.config.startBlockHeight + verifiedSnapshot.config.periodLengthBlocks * 10,
        }),
        queryUnspentByLockingBytecode: vi.fn(async (lockingBytecodeHex: string, tokenId: string) => {
          if (
            tokenId === verifiedSnapshot.config.tokenIds.paryonTokenId &&
            lockingBytecodeHex === verifiedSnapshot.contractsByName.PriceContract.lockingBytecodeHex
          ) {
            return {
              data: {
                output: [
                  {
                    transaction_hash: 'price',
                    output_index: 0,
                    value_satoshis: '1000',
                    nonfungible_token_commitment: '00002710',
                    fungible_token_amount: '0',
                    nonfungible_token_capability: 'mutable',
                  },
                ],
              },
            };
          }

          if (
            tokenId === verifiedSnapshot.config.tokenIds.paryonTokenId &&
            lockingBytecodeHex === verifiedSnapshot.contractsByName.Borrowing.lockingBytecodeHex
          ) {
            return {
              data: {
                output: [
                  {
                    transaction_hash: 'borrowing',
                    output_index: 0,
                    value_satoshis: '1000',
                    nonfungible_token_commitment: '00000000',
                    fungible_token_amount: '0',
                    nonfungible_token_capability: 'minting',
                  },
                ],
              },
            };
          }

          if (tokenId === verifiedSnapshot.config.tokenIds.poolTokenId) {
            return {
              data: {
                output: [
                  {
                    transaction_hash: 'pool',
                    output_index: 0,
                    value_satoshis: '1000',
                    nonfungible_token_commitment: '0000000a00000000000a000000000014',
                    fungible_token_amount: '0',
                    nonfungible_token_capability: 'minting',
                  },
                ],
              },
            };
          }

          if (tokenId === verifiedSnapshot.config.tokenIds.redeemerTokenId) {
            return {
              data: {
                output: [
                  {
                    transaction_hash: 'redeemer',
                    output_index: 0,
                    value_satoshis: '1000',
                    nonfungible_token_commitment: '00000000',
                    fungible_token_amount: '0',
                    nonfungible_token_capability: 'minting',
                  },
                ],
              },
            };
          }

          if (tokenId === verifiedSnapshot.config.tokenIds.loanKeyFactoryTokenId) {
            return {
              data: {
                output: [
                  {
                    transaction_hash: 'loan-key-factory',
                    output_index: 0,
                    value_satoshis: '1000',
                    nonfungible_token_commitment: '00000000',
                    fungible_token_amount: '0',
                    nonfungible_token_capability: 'minting',
                  },
                ],
              },
            };
          }

          return { data: { output: [] } };
        }),
      },
    } as unknown as AddonSDK;

    const snapshot = await loadParyonNativeSnapshot(sdk, verifiedSnapshot);

    expect(snapshot.balances.bchSats).toBe(123_457_789n);
    expect(snapshot.balances.pusdAtomic).toBe(2_500n);
    expect(snapshot.balances.spendableUtxoCount).toBe(2);
    expect(snapshot.balances.tokenUtxoCount).toBe(1);
    expect(snapshot.positions.loans).toBe(1);
    expect(snapshot.positions.stakes).toBe(1);
    expect(snapshot.positions.redemptions).toBe(1);
    expect(snapshot.positionIndex.summary.total).toBe(4);
    expect(snapshot.positionIndex.loans[0].state).toBe('live');
    expect(snapshot.threadHealth.every((thread) => thread.freshness === 'fresh')).toBe(true);
    expect(snapshot.market.oraclePriceCentsPerBch).toBe(10_000n);
    expect(snapshot.market.currentPeriod).toBe(10);
    expect(snapshot.market.currentEpoch).toBe(1);
    expect(snapshot.market.chainHeight).toBe(
      verifiedSnapshot.config.startBlockHeight + verifiedSnapshot.config.periodLengthBlocks * 10
    );
    expect(snapshot.market.expectedPeriod).toBe(10);
    expect(snapshot.market.periodDeltaPeriods).toBe(0);
    expect(snapshot.market.writeEnabled).toBe(true);
    expect(snapshot.liveContracts.PriceContract.resolved).toBe(true);
    expect(snapshot.liveContracts.StabilityPool.resolved).toBe(true);
    expect(snapshot.flowPlans.loan.ready).toBe(true);
    expect(snapshot.flowPlans.pool.ready).toBe(true);
    expect(snapshot.flowPlans.redemption.ready).toBe(true);
    expect(snapshot.flowPlans.operator.ready).toBe(true);
    expect(snapshot.systemHealth.canWrite).toBe(true);
  });

  it('falls back to Electrum address reads when ChainGraph misses a live verified contract', async () => {
    const priceAddress = verifiedSnapshot.contractsByName.PriceContract.address;

    const sdk = {
      wallet: {
        getContext: () => ({ walletId: 1, network: 'mainnet' }),
      },
      utxos: {
        listForWallet: vi.fn().mockResolvedValue({
          allUtxos: [],
          tokenUtxos: [],
        }),
        listForAddress: vi.fn(async (address: string) => {
          if (address === priceAddress) {
            return [
              {
                tx_hash: 'price-electrum',
                tx_pos: 0,
                value: 1_000,
                token: {
                  category: verifiedSnapshot.config.tokenIds.paryonTokenId,
                  amount: 0,
                  nft: {
                    capability: 'mutable',
                    commitment: '00002710',
                  },
                },
              },
            ];
          }

          return [];
        }),
      },
      chain: {
        getLatestBlock: vi.fn().mockResolvedValue({
          height:
            verifiedSnapshot.config.startBlockHeight +
            verifiedSnapshot.config.periodLengthBlocks * 10,
        }),
        queryUnspentByLockingBytecode: vi.fn(async (lockingBytecodeHex: string, tokenId: string) => {
          if (
            tokenId === verifiedSnapshot.config.tokenIds.paryonTokenId &&
            lockingBytecodeHex === verifiedSnapshot.contractsByName.Borrowing.lockingBytecodeHex
          ) {
            return {
              data: {
                output: [
                  {
                    transaction_hash: 'borrowing',
                    output_index: 0,
                    value_satoshis: '1000',
                    nonfungible_token_commitment: '00000000',
                    fungible_token_amount: '0',
                    nonfungible_token_capability: 'minting',
                  },
                ],
              },
            };
          }

          if (
            tokenId === verifiedSnapshot.config.tokenIds.poolTokenId &&
            lockingBytecodeHex === verifiedSnapshot.contractsByName.StabilityPool.lockingBytecodeHex
          ) {
            return {
              data: {
                output: [
                  {
                    transaction_hash: 'pool',
                    output_index: 0,
                    value_satoshis: '1000',
                    nonfungible_token_commitment: '0000000a00000000000a000000000014',
                    fungible_token_amount: '0',
                    nonfungible_token_capability: 'minting',
                  },
                ],
              },
            };
          }

          if (
            tokenId === verifiedSnapshot.config.tokenIds.redeemerTokenId &&
            lockingBytecodeHex === verifiedSnapshot.contractsByName.Redeemer.lockingBytecodeHex
          ) {
            return {
              data: {
                output: [
                  {
                    transaction_hash: 'redeemer',
                    output_index: 0,
                    value_satoshis: '1000',
                    nonfungible_token_commitment: '00000000',
                    fungible_token_amount: '0',
                    nonfungible_token_capability: 'minting',
                  },
                ],
              },
            };
          }

          if (
            tokenId === verifiedSnapshot.config.tokenIds.loanKeyFactoryTokenId &&
            lockingBytecodeHex === verifiedSnapshot.contractsByName.LoanKeyFactory.lockingBytecodeHex
          ) {
            return {
              data: {
                output: [
                  {
                    transaction_hash: 'loan-key-factory',
                    output_index: 0,
                    value_satoshis: '1000',
                    nonfungible_token_commitment: '00000000',
                    fungible_token_amount: '0',
                    nonfungible_token_capability: 'minting',
                  },
                ],
              },
            };
          }

          return { data: { output: [] } };
        }),
      },
    } as unknown as AddonSDK;

    const snapshot = await loadParyonNativeSnapshot(sdk, verifiedSnapshot);

    expect(sdk.utxos.listForAddress).toHaveBeenCalledWith(priceAddress);
    expect(snapshot.liveContracts.PriceContract.resolved).toBe(true);
    expect(snapshot.market.oraclePriceCentsPerBch).toBe(10_000n);
    expect(snapshot.systemHealth.canWrite).toBe(true);
  });

  it('accepts verified contract outputs even when the token category does not match the expected category', async () => {
    const priceAddress = verifiedSnapshot.contractsByName.PriceContract.address;
    const randomCategory = 'deadbeef'.repeat(8);

    const sdk = {
      wallet: {
        getContext: () => ({ walletId: 1, network: 'mainnet' }),
      },
      utxos: {
        listForWallet: vi.fn().mockResolvedValue({
          allUtxos: [],
          tokenUtxos: [],
        }),
        listForAddress: vi.fn(async (address: string) => {
          if (address === priceAddress) {
            return [
              {
                tx_hash: 'price-electrum-mismatch',
                tx_pos: 0,
                value: 1_000,
                token: {
                  category: randomCategory,
                  amount: 0,
                  nft: {
                    capability: 'mutable',
                    commitment: '00002710',
                  },
                },
              },
            ];
          }

          return [];
        }),
      },
      chain: {
        getLatestBlock: vi.fn().mockResolvedValue({
          height:
            verifiedSnapshot.config.startBlockHeight +
            verifiedSnapshot.config.periodLengthBlocks * 10,
        }),
        queryUnspentByLockingBytecode: vi.fn(async () => ({ data: { output: [] } })),
      },
    } as unknown as AddonSDK;

    const snapshot = await loadParyonNativeSnapshot(sdk, verifiedSnapshot);

    expect(snapshot.liveContracts.PriceContract.resolved).toBe(true);
    expect(snapshot.market.oraclePriceCentsPerBch).toBe(10_000n);
    expect(snapshot.liveContracts.PriceContract.warnings.join(' ')).toContain(
      'non-matching token category'
    );
  });
});
