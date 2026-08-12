import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { UTXO } from '../../../../../types/types';
import type { AddonSDK } from '../../../../../services/AddonsSDK';
import {
  buildApprovedDistributionTransaction,
  executeApprovedDistributionSend,
} from '../executeDistributionSend';
import type { DistributionJobRecord } from '../../types';

vi.mock('@bitauth/libauth', () => ({
  decodeCashAddress: vi.fn((address: string) => {
    if (address.includes(':qq')) {
      return {
        prefix: 'bchtest',
        type: 'p2pkh',
        payload: new Uint8Array(20),
      };
    }
    if (address.includes(':zq')) {
      return {
        prefix: 'bchtest',
        type: 'p2pkhWithTokens',
        payload: new Uint8Array(20),
      };
    }
    return 'invalid';
  }),
  encodeCashAddress: vi.fn(() => ({
    address: 'bchtest:zqconverted0000000000000000000000000000000',
  })),
}));

const plannerMock = {
  makeTokenOutputForRecipientFT: vi.fn(),
  makeTokenChangeOutputFT: vi.fn(),
  addBchInputsUntilBuild: vi.fn(),
};

const sendTransactionMock = vi.fn();
const selectTokenFtInputsMock = vi.fn();

vi.mock('../../../../../hooks/simple-send/planner', () => ({
  createSimpleSendPlanner: vi.fn(() => plannerMock),
}));

vi.mock('../../../../../services/CoinSelectionService', () => ({
  selectTokenFtInputs: (...args: unknown[]) => selectTokenFtInputsMock(...args),
}));

vi.mock('../../../../../services/TransactionService', () => ({
  default: {
    sendTransaction: (...args: unknown[]) => sendTransactionMock(...args),
  },
}));

describe('executeApprovedDistributionSend', () => {
  const feeUtxo: UTXO = {
    address: 'bchtest:qpmockfee000000000000000000000000000000000',
    height: 1,
    tx_hash: 'feehash',
    tx_pos: 0,
    value: 5000,
  };

  const tokenUtxo: UTXO = {
    address: 'bchtest:qpmocktoken0000000000000000000000000000000',
    tokenAddress: 'bchtest:zpmocktoken0000000000000000000000000000000',
    height: 1,
    tx_hash: 'tokenhash',
    tx_pos: 1,
    value: 1000,
    token: {
      category: '8d76840bf20eb57f002e67f0ddec0698639db6c99c4a9c736f711b7c86fcbf22',
      amount: 100n,
    },
  };

  const sdk = {
    wallet: {
      listAddresses: vi.fn(async () => [
        {
          address: 'bchtest:qqchange0000000000000000000000000000000',
          tokenAddress: 'bchtest:zqchange0000000000000000000000000000000',
        },
      ]),
    },
    utxos: {
      listForWallet: vi.fn(async () => ({
        allUtxos: [feeUtxo, tokenUtxo],
        tokenUtxos: [tokenUtxo],
      })),
    },
  } as unknown as AddonSDK;

  const api = {
    completeDistributionJob: vi.fn(async () => ({})),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    plannerMock.makeTokenOutputForRecipientFT.mockReturnValue({
      recipientAddress: 'bchtest:qqdest000000000000000000000000000000000',
      amount: 1000,
      token: {
        category: tokenUtxo.token!.category,
        amount: 25n,
      },
    });
    plannerMock.makeTokenChangeOutputFT.mockImplementation((amount: bigint) => ({
      recipientAddress: 'bchtest:zqchange0000000000000000000000000000000',
      amount: 1000,
      token: {
        category: tokenUtxo.token!.category,
        amount,
      },
    }));
    plannerMock.addBchInputsUntilBuild.mockResolvedValue({
      ok: true,
      rawTx: 'deadbeef',
      inputs: [tokenUtxo, feeUtxo],
      finalOutputs: [
        {
          recipientAddress: 'bchtest:qqdest000000000000000000000000000000000',
          amount: 1000,
          token: {
            category: tokenUtxo.token!.category,
            amount: 25n,
          },
        },
        {
          recipientAddress: 'bchtest:qqdest111111111111111111111111111111111',
          amount: 1000,
          token: {
            category: tokenUtxo.token!.category,
            amount: 25n,
          },
        },
        {
          recipientAddress: 'bchtest:zqchange0000000000000000000000000000000',
          amount: 1000,
          token: {
            category: tokenUtxo.token!.category,
            amount: 50n,
          },
        },
        {
          recipientAddress: 'bchtest:qqchange0000000000000000000000000000000',
          amount: 3456,
        },
      ],
      feeSats: 321,
      totalSats: 4321,
    });
    selectTokenFtInputsMock.mockReturnValue({
      tokenInputs: [tokenUtxo],
      totalTokenAmount: 100n,
    });
    sendTransactionMock.mockResolvedValue({
      txid: 'mocked-txid-123',
      errorMessage: null,
    });
  });

  it('prepares, broadcasts, and completes an approved token request using mocked UTXOs', async () => {
    const result = await executeApprovedDistributionSend(sdk, api, [
      {
        id: 'dst_1',
        workspace_id: 'wrk_1',
        recipient_id: 'rcp_1',
        destination_address: 'bchtest:qqdest000000000000000000000000000000000',
        asset_type: 'token',
        status: 'prepared',
        token_category: tokenUtxo.token!.category,
        amount: '25',
      } as DistributionJobRecord,
      {
        id: 'dst_2',
        workspace_id: 'wrk_1',
        recipient_id: 'rcp_2',
        destination_address: 'bchtest:qqdest111111111111111111111111111111111',
        asset_type: 'token',
        status: 'prepared',
        token_category: tokenUtxo.token!.category,
        amount: '25',
      } as DistributionJobRecord,
    ]);

    expect(selectTokenFtInputsMock).toHaveBeenCalledWith(
      tokenUtxo.token!.category,
      [tokenUtxo],
      50n,
      { preferConfirmed: false, maxInputs: 100 }
    );
    expect(plannerMock.addBchInputsUntilBuild).toHaveBeenCalled();
    expect(sendTransactionMock).toHaveBeenCalledWith(
      'deadbeef',
      [tokenUtxo, feeUtxo],
      {
        source: 'airdrops',
        sourceLabel: 'Airdrops',
        amountSummary: '2 recipients',
      }
    );
    expect(api.completeDistributionJob).toHaveBeenCalledTimes(2);
    expect(api.completeDistributionJob).toHaveBeenNthCalledWith(1, {
      jobId: 'dst_1',
      status: 'sent',
      txid: 'mocked-txid-123',
    });
    expect(api.completeDistributionJob).toHaveBeenNthCalledWith(2, {
      jobId: 'dst_2',
      status: 'sent',
      txid: 'mocked-txid-123',
    });
    expect(result).toEqual({
      txid: 'mocked-txid-123',
      spentInputs: [tokenUtxo, feeUtxo],
      finalOutputs: [
        {
          recipientAddress: 'bchtest:qqdest000000000000000000000000000000000',
          amount: 1000,
          token: {
            category: tokenUtxo.token!.category,
            amount: 25n,
          },
        },
        {
          recipientAddress: 'bchtest:qqdest111111111111111111111111111111111',
          amount: 1000,
          token: {
            category: tokenUtxo.token!.category,
            amount: 25n,
          },
        },
        {
          recipientAddress: 'bchtest:zqchange0000000000000000000000000000000',
          amount: 1000,
          token: {
            category: tokenUtxo.token!.category,
            amount: 50n,
          },
        },
        {
          recipientAddress: 'bchtest:qqchange0000000000000000000000000000000',
          amount: 3456,
        },
      ],
      jobIds: ['dst_1', 'dst_2'],
    });
  });

  it('converts token recipients to CashTokens address format during build', async () => {
    await buildApprovedDistributionTransaction(sdk, [
      {
        id: 'dst_1',
        workspace_id: 'wrk_1',
        recipient_id: 'rcp_1',
        destination_address: 'bchtest:qqdest000000000000000000000000000000000',
        asset_type: 'token',
        status: 'prepared',
        token_category: tokenUtxo.token!.category,
        amount: '25',
      } as DistributionJobRecord,
    ]);

    expect(plannerMock.addBchInputsUntilBuild).toHaveBeenCalledWith(
      [tokenUtxo],
      [
        {
          recipientAddress: 'bchtest:zqconverted0000000000000000000000000000000',
          amount: 1000,
          token: {
            category: tokenUtxo.token!.category,
            amount: 25n,
          },
        },
        {
          recipientAddress: 'bchtest:zqchange0000000000000000000000000000000',
          amount: 1000,
          token: {
            category: tokenUtxo.token!.category,
            amount: 75n,
          },
        },
      ],
      100
    );
  });
});
