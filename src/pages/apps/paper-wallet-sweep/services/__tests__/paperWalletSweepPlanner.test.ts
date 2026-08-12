import { describe, expect, it, vi, beforeEach } from 'vitest';
import { buildPaperWalletSweepPlan } from '../paperWalletSweepPlanner';
import type { UTXO } from '../../../../../types/types';

const buildTransactionMock = vi.fn();

vi.mock('../../../../../services/TransactionService', () => ({
  default: {
    buildTransaction: (...args: unknown[]) => buildTransactionMock(...args),
  },
}));

function makeUtxo(overrides: Partial<UTXO>): UTXO {
  return {
    address: 'bitcoincash:qpaper',
    height: 1,
    tx_hash: `${Math.random().toString(16).slice(2).padEnd(64, '0')}`.slice(0, 64),
    tx_pos: 0,
    value: 1000,
    amount: 1000,
    ...overrides,
  } as UTXO;
}

describe('buildPaperWalletSweepPlan', () => {
  beforeEach(() => {
    buildTransactionMock.mockReset();
    buildTransactionMock.mockResolvedValue({
      bytecodeSize: 250,
      finalTransaction: 'deadbeef',
      finalOutputs: null,
      errorMsg: '',
    });
  });

  it('builds one combined sweep plan for BCH, FT, and NFT paper wallet UTXOs', async () => {
    const bch1 = makeUtxo({ tx_hash: 'a'.repeat(64), tx_pos: 0, value: 7000, amount: 7000 });
    const bch2 = makeUtxo({ tx_hash: 'b'.repeat(64), tx_pos: 1, value: 3000, amount: 3000 });
    const ft1 = makeUtxo({
      tx_hash: 'c'.repeat(64),
      tx_pos: 2,
      value: 1000,
      amount: 1000,
      token: { category: '11'.repeat(32), amount: 5 },
    });
    const ft2 = makeUtxo({
      tx_hash: 'd'.repeat(64),
      tx_pos: 3,
      value: 1000,
      amount: 1000,
      token: { category: '11'.repeat(32), amount: 7 },
    });
    const nft = makeUtxo({
      tx_hash: 'e'.repeat(64),
      tx_pos: 4,
      value: 1000,
      amount: 1000,
      token: {
        category: '22'.repeat(32),
        amount: 0,
        nft: { capability: 'minting', commitment: 'abcd' },
      },
    });

    const plan = await buildPaperWalletSweepPlan({
      paperWalletAddress: 'bitcoincash:qpaper',
      destinationAddress: 'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a',
      paperWalletUtxos: [bch1, bch2, ft1, ft2, nft],
      walletFeeUtxos: [],
    });

    expect(buildTransactionMock).toHaveBeenCalledTimes(1);
    const [, , changeAddress, inputs] = buildTransactionMock.mock.calls[0];
    expect(changeAddress).toBe('bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a');
    expect(inputs).toHaveLength(5);
    expect(plan.outputs).toHaveLength(2);

    const ftOutput = plan.outputs.find((o) => o.token?.category === '11'.repeat(32));
    expect(ftOutput).toEqual({
      recipientAddress: 'bitcoincash:zpm2qsznhks23z7629mms6s4cwef74vcwvrqekrq9w',
      amount: 1000,
      token: {
        category: '11'.repeat(32),
        amount: 12n,
      },
    });

    const nftOutput = plan.outputs.find((o) => o.token?.category === '22'.repeat(32));
    expect(nftOutput).toEqual({
      recipientAddress: 'bitcoincash:zpm2qsznhks23z7629mms6s4cwef74vcwvrqekrq9w',
      amount: 1000,
      token: {
        category: '22'.repeat(32),
        amount: 0n,
        nft: { capability: 'minting', commitment: 'abcd' },
      },
    });
  });

  it('tops up fees with wallet BCH inputs without splitting the sweep into multiple transactions', async () => {
    const bch = makeUtxo({
      tx_hash: 'f'.repeat(64),
      tx_pos: 0,
      value: 650,
      amount: 650,
    });
    const ft = makeUtxo({
      tx_hash: '1'.repeat(64),
      tx_pos: 1,
      value: 1000,
      amount: 1000,
      token: { category: '33'.repeat(32), amount: 9 },
    });
    const nft = makeUtxo({
      tx_hash: '2'.repeat(64),
      tx_pos: 2,
      value: 1000,
      amount: 1000,
      token: {
        category: '44'.repeat(32),
        amount: 0,
        nft: { capability: 'mutable', commitment: 'beef' },
      },
    });
    const feeTopUp = makeUtxo({
      address: 'bitcoincash:qwalletfee',
      tx_hash: '3'.repeat(64),
      tx_pos: 5,
      value: 4000,
      amount: 4000,
      token: undefined,
    });

    buildTransactionMock
      .mockResolvedValueOnce({
        bytecodeSize: 260,
        finalTransaction: '',
        finalOutputs: null,
        errorMsg: 'Min relay fee not met under 1 sat/byte policy.',
      })
      .mockResolvedValueOnce({
        bytecodeSize: 420,
        finalTransaction: 'c0ffee',
        finalOutputs: null,
        errorMsg: '',
      });

    const plan = await buildPaperWalletSweepPlan({
      paperWalletAddress: 'bitcoincash:qpaper',
      destinationAddress: 'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a',
      paperWalletUtxos: [bch, ft, nft],
      walletFeeUtxos: [feeTopUp],
    });

    expect(buildTransactionMock).toHaveBeenCalledTimes(2);
    expect(buildTransactionMock.mock.calls[0][3]).toHaveLength(3);
    expect(buildTransactionMock.mock.calls[1][3]).toHaveLength(4);
    expect(plan.feeInputs).toEqual([feeTopUp]);
    expect(plan.outputs).toHaveLength(2);
    expect(plan.outputs.every((out) => !('opReturn' in out))).toBe(true);
  });
});
