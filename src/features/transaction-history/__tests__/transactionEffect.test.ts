import { describe, expect, it } from 'vitest';
import { deriveWalletTransactionEffect } from '../transactionEffect';

describe('deriveWalletTransactionEffect', () => {
  const wallet = new Set(['bitcoincash:qwallet']);

  it('derives an outgoing net amount from wallet inputs and change', () => {
    const effect = deriveWalletTransactionEffect(
      {
        txid: 'outgoing',
        confirmations: 1,
        inputs: [{ address: 'bitcoincash:qwallet', amountSats: 100_000 }],
        outputs: [
          { address: 'bitcoincash:qrecipient', amountSats: 70_000 },
          { address: 'bitcoincash:qwallet', amountSats: 29_000 },
        ],
      },
      wallet
    );

    expect(effect?.bchDeltaSats).toBe(-71_000);
  });

  it('returns an incoming amount when the wallet owns only an output', () => {
    const effect = deriveWalletTransactionEffect(
      {
        txid: 'incoming',
        confirmations: 1,
        inputs: [{ address: 'bitcoincash:qsender', amountSats: 100_000 }],
        outputs: [{ address: 'bitcoincash:qwallet', amountSats: 99_000 }],
      },
      wallet
    );

    expect(effect?.bchDeltaSats).toBe(99_000);
  });

  it('keeps unknown ownership out of the UI instead of showing zero', () => {
    expect(
      deriveWalletTransactionEffect(
        {
          txid: 'unknown',
          confirmations: 0,
          inputs: [{ address: 'bitcoincash:qsender', amountSats: 1_000 }],
          outputs: [{ address: 'bitcoincash:qrecipient', amountSats: 900 }],
        },
        wallet
      )
    ).toBeNull();
  });

  it('derives CashToken net effects by category from wallet-owned rows', () => {
    const effect = deriveWalletTransactionEffect(
      {
        txid: 'token-transfer',
        confirmations: 1,
        inputs: [
          {
            address: 'bitcoincash:qwallet',
            amountSats: 20_000,
            token: { category: 'AB'.repeat(32), amount: 10_000n },
          },
        ],
        outputs: [
          {
            address: 'bitcoincash:qwallet',
            amountSats: 19_000,
            token: { category: 'ab'.repeat(32), amount: 9_250n },
          },
          {
            address: 'bitcoincash:qrecipient',
            amountSats: 1_000,
            token: { category: 'ab'.repeat(32), amount: 750n },
          },
        ],
      },
      wallet
    );

    expect(effect?.tokenDeltas).toEqual([
      { category: 'ab'.repeat(32), amount: -750n },
    ]);
  });

  it('omits token categories whose wallet change nets to zero', () => {
    const effect = deriveWalletTransactionEffect(
      {
        txid: 'token-change',
        confirmations: 1,
        inputs: [
          {
            address: 'bitcoincash:qwallet',
            amountSats: 20_000,
            token: { category: 'cd'.repeat(32), amount: 10n },
          },
        ],
        outputs: [
          {
            address: 'bitcoincash:qwallet',
            amountSats: 19_000,
            token: { category: 'cd'.repeat(32), amount: 10n },
          },
        ],
      },
      wallet
    );

    expect(effect?.tokenDeltas).toEqual([]);
  });
});
