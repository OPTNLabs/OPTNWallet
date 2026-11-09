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
});
