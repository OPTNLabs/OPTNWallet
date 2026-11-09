import { describe, expect, it } from 'vitest';
import type { TransactionOutput, UTXO } from '../../../../types/types';
import {
  authorizeAuthGuardBroadcast,
  assertAuthGuardReviewContext,
  prepareAuthGuardBroadcastReview,
} from '../authGuardReview';

const input: UTXO = {
  address: 'bchtest:qsource',
  height: 1,
  tx_hash: 'aa'.repeat(32),
  tx_pos: 0,
  value: 10_000,
};

const outputs: TransactionOutput[] = [
  { recipientAddress: 'bchtest:qrecipient', amount: 9_500 },
];

const built = {
  hex: '0200000001',
  bytes: 5,
  finalOutputs: outputs,
  errorMsg: '',
};

describe('AuthGuard broadcast review', () => {
  it('uses the final built outputs, exact hex and fee in the review', () => {
    const review = prepareAuthGuardBroadcastReview([input], built);
    expect(review).toEqual({
      hex: built.hex,
      bytes: 5,
      inputs: [input],
      outputs,
      feeSats: 500,
    });
  });

  it('blocks a missing final output plan or invalid transaction hex', () => {
    expect(() =>
      prepareAuthGuardBroadcastReview([input], {
        ...built,
        finalOutputs: null,
      })
    ).toThrow('final transaction outputs are unavailable');
    expect(() =>
      prepareAuthGuardBroadcastReview([input], { ...built, hex: '' })
    ).toThrow('built transaction is missing or invalid');
  });

  it('blocks an unaccounted input token', () => {
    const tokenInput: UTXO = {
      ...input,
      token: { category: 'bb'.repeat(32), amount: 1n },
    };
    expect(() => prepareAuthGuardBroadcastReview([tokenInput], built)).toThrow(
      'does not account for every input token'
    );
  });

  it('requires the reviewed wallet and network to remain active', () => {
    const prepared = { walletId: 7, network: 'chipnet' };
    expect(() =>
      assertAuthGuardReviewContext(prepared, prepared)
    ).not.toThrow();
    expect(() =>
      assertAuthGuardReviewContext(prepared, {
        walletId: 8,
        network: 'chipnet',
      })
    ).toThrow('Wallet or network changed');
    expect(() =>
      assertAuthGuardReviewContext(prepared, {
        walletId: 7,
        network: 'mainnet',
      })
    ).toThrow('Wallet or network changed');
  });

  it('broadcasts only the approved transaction hex', async () => {
    const broadcasted: string[] = [];
    const transaction = {
      ...prepareAuthGuardBroadcastReview([input], built),
      walletId: 7,
      network: 'chipnet',
    };
    const result = await authorizeAuthGuardBroadcast(
      transaction,
      () => ({ walletId: 7, network: 'chipnet' }),
      async () => true,
      async (hex) => {
        broadcasted.push(hex);
        return 'txid';
      }
    );
    expect(result).toBe('txid');
    expect(broadcasted).toEqual([built.hex]);
  });

  it('does not broadcast after cancellation or a context change', async () => {
    const transaction = {
      ...prepareAuthGuardBroadcastReview([input], built),
      walletId: 7,
      network: 'chipnet',
    };
    const broadcast = async () => 'unexpected';
    await expect(
      authorizeAuthGuardBroadcast(
        transaction,
        () => ({ walletId: 7, network: 'chipnet' }),
        async () => false,
        broadcast
      )
    ).resolves.toBeNull();

    let network = 'chipnet';
    await expect(
      authorizeAuthGuardBroadcast(
        transaction,
        () => ({ walletId: 7, network }),
        async () => {
          network = 'mainnet';
          return true;
        },
        broadcast
      )
    ).rejects.toThrow('Wallet or network changed');
  });
});
