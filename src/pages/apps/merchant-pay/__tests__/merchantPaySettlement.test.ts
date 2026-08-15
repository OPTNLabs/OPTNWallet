import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AddonSDK } from '../../../../services/AddonsSDK';
import { Network } from '../../../../state/slices/networkSlice';
import { attemptMerchantAutoSettlement } from '../merchantPaySettlement';

const mocks = vi.hoisted(() => ({
  buildMerchantPaymentWithFundingMock: vi.fn(),
  signAndBroadcastMerchantPaymentMock: vi.fn(),
  listAllOutboundTransactionsMock: vi.fn(),
}));

vi.mock('../merchantPayTransactions', () => ({
  buildMerchantPaymentWithFunding: (...args: unknown[]) =>
    mocks.buildMerchantPaymentWithFundingMock(...args),
  signAndBroadcastMerchantPayment: (...args: unknown[]) =>
    mocks.signAndBroadcastMerchantPaymentMock(...args),
}));

vi.mock('../../../../services/OutboundTransactionTracker', () => ({
  default: {
    listAll: (...args: unknown[]) =>
      mocks.listAllOutboundTransactionsMock(...args),
  },
}));

describe('attemptMerchantAutoSettlement', () => {
  beforeEach(() => {
    mocks.buildMerchantPaymentWithFundingMock.mockReset();
    mocks.signAndBroadcastMerchantPaymentMock.mockReset();
    mocks.listAllOutboundTransactionsMock.mockReset();
  });

  it('waits until the incoming payment is distinct from wallet-originated outputs', async () => {
    const sdk = {
      utxos: {
        listForAddress: vi.fn(async () => [
          {
            address: 'bitcoincash:qpayment',
            tokenAddress: 'bitcoincash:qpayment',
            amount: 5_000_000,
            value: 5_000_000,
            tx_hash: 'self-tx',
            tx_pos: 0,
            height: 1,
          },
        ]),
      },
      wallet: {
        listAddresses: vi.fn(),
        toTokenAddress: vi.fn(),
      },
    } as never as AddonSDK;
    mocks.listAllOutboundTransactionsMock.mockResolvedValue([
      {
        txid: 'self-tx',
      },
    ]);

    const result = await attemptMerchantAutoSettlement({
      sdk,
      walletId: 7,
      paymentRequest: {
        requestId: 'req-1',
        createdAt: 1,
        expiresAt: 2,
        network: Network.MAINNET,
        merchantAddress: 'bitcoincash:qpayment',
        merchantAddressBaselineOutpoints: [],
        stablecoin: {
          tokenId: 'token',
          symbol: 'MUSD',
          name: 'Moria USD',
          decimals: 2,
        },
        merchantReceivesAtomic: 1000n,
        merchantReceivesDisplay: '10.00 MUSD',
        customerPaysSats: 5_000_000n,
        customerPaysDisplay: '0.05000000 BCH',
        quoteProtectionBps: 100n,
        routePoolCount: 2,
        maxBchSats: 5_000_000n,
        detailsText: 'details',
      },
      draftTrades: [{ pool: {} } as never],
      selectedStablecoin: {
        tokenId: 'token',
        symbol: 'MUSD',
        name: 'Moria USD',
        decimals: 2,
      },
    });

    expect(result.status).toBe('waiting');
    expect(result.availableBchSats).toBe(0n);
    expect(mocks.buildMerchantPaymentWithFundingMock).not.toHaveBeenCalled();
    expect(mocks.signAndBroadcastMerchantPaymentMock).not.toHaveBeenCalled();
  });

  it('builds and broadcasts the settlement once the incoming payment arrives', async () => {
    const sdk = {
      utxos: {
        listForAddress: vi.fn(async () => [
          {
            address: 'bitcoincash:qpayment',
            tokenAddress: 'bitcoincash:qpayment',
            amount: 2_000_000,
            value: 2_000_000,
            tx_hash: 'tx-old',
            tx_pos: 0,
            height: 1,
          },
          {
            address: 'bitcoincash:qpayment',
            tokenAddress: 'bitcoincash:qpayment',
            amount: 4_000_000,
            value: 4_000_000,
            tx_hash: 'tx-new',
            tx_pos: 1,
            height: 2,
          },
        ]),
      },
      wallet: {
        listAddresses: vi.fn(async () => [
          {
            address: 'bitcoincash:qmerchant',
            tokenAddress: 'bitcoincash:zmerchant',
          },
        ]),
        toTokenAddress: vi.fn(async () => 'bitcoincash:zmerchant'),
      },
    } as never as AddonSDK;
    mocks.listAllOutboundTransactionsMock.mockResolvedValue([]);

    mocks.buildMerchantPaymentWithFundingMock.mockResolvedValue({
      signRequest: {
        transaction: {
          userPrompt: 'Merchant Pay settlement req-2',
        },
      },
      walletInputs: [],
      sourceOutputs: [],
      settlementOutputs: [],
      estimatedFeeSatoshis: 1n,
      supplyTokenId: 'bch',
      demandTokenId: 'token',
      totalSupply: 0n,
      totalDemand: 0n,
      paymentKind: 'merchant',
    });
    mocks.signAndBroadcastMerchantPaymentMock.mockResolvedValue({
      txid: 'txid-123',
      errorMessage: null,
    });

    const result = await attemptMerchantAutoSettlement({
      sdk,
      walletId: 7,
      paymentRequest: {
        requestId: 'req-2',
        createdAt: 1,
        expiresAt: 2,
        network: Network.MAINNET,
        merchantAddress: 'bitcoincash:qpayment',
        merchantAddressBaselineOutpoints: ['tx-old:0'],
        stablecoin: {
          tokenId: 'token',
          symbol: 'MUSD',
          name: 'Moria USD',
          decimals: 2,
        },
        merchantReceivesAtomic: 1000n,
        merchantReceivesDisplay: '10.00 MUSD',
        customerPaysSats: 4_000_000n,
        customerPaysDisplay: '0.04000000 BCH',
        quoteProtectionBps: 100n,
        routePoolCount: 2,
        maxBchSats: 4_000_000n,
        detailsText: 'details',
      },
      draftTrades: [{ pool: {} } as never],
      selectedStablecoin: {
        tokenId: 'token',
        symbol: 'MUSD',
        name: 'Moria USD',
        decimals: 2,
      },
    });

    expect(result.status).toBe('settled');
    expect(result.txid).toBe('txid-123');
    expect(mocks.buildMerchantPaymentWithFundingMock).toHaveBeenCalledTimes(1);
    expect(
      mocks.buildMerchantPaymentWithFundingMock.mock.calls[0]?.[0]
    ).toEqual(
      expect.objectContaining({
        walletId: 7,
        merchantAddress: 'bitcoincash:zmerchant',
        changeAddress: 'bitcoincash:qmerchant',
        tokenChangeAddress: 'bitcoincash:zmerchant',
        feeRate: 2n,
      })
    );
    expect(
      mocks.buildMerchantPaymentWithFundingMock.mock.calls[0]?.[0].allUtxos
    ).toEqual([
      expect.objectContaining({
        tx_hash: 'tx-new',
        tx_pos: 1,
      }),
    ]);
    expect(mocks.signAndBroadcastMerchantPaymentMock).toHaveBeenCalledTimes(1);
  });
});
