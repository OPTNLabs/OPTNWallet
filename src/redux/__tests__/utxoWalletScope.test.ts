import { describe, expect, it } from 'vitest';

import utxoReducer, { replaceAllUTXOs } from '../../state/slices/utxoSlice';
import { resetWallet, setWalletId } from '../../state/slices/walletSlice';

function fundedUtxoState() {
  return utxoReducer(
    undefined,
    replaceAllUTXOs({
      utxosByAddress: {
        'bchtest:qwalletfive': [
          {
            wallet_id: 5,
            address: 'bchtest:qwalletfive',
            height: 1,
            tx_hash: 'wallet-five-tx',
            tx_pos: 0,
            value: 1_000_000_000,
          },
        ],
      },
    })
  );
}

const emptyUtxoState = utxoReducer(undefined, { type: 'test/init' });

describe('utxoSlice wallet scope', () => {
  it.each([
    ['opening a wallet', setWalletId(5)],
    ['changing to another wallet', setWalletId(6)],
    ['closing the active wallet', resetWallet()],
  ])('clears all in-memory UTXOs when %s', (_scenario, action) => {
    const state = utxoReducer(fundedUtxoState(), action);

    expect(state).toEqual(emptyUtxoState);
  });
});
