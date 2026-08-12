import { describe, expect, it } from 'vitest';
import {
  addTransactions,
  resetTransactions,
  setTransactions,
} from './transactionSlice';
import { resetWallet, setWalletId } from './walletSlice';
import reducer from './transactionSlice';

const transaction = (tx_hash: string) => ({
  tx_hash,
  height: 1,
});

describe('transaction slice wallet-session boundaries', () => {
  it('clears history when the wallet session changes and rejects late writes', () => {
    let state = reducer(
      undefined,
      setTransactions({
        wallet_id: 7,
        transactions: [transaction('old')],
        sessionGeneration: 1,
      })
    );

    state = reducer(state, setWalletId(7));
    expect(state.transactions).toEqual({});

    state = reducer(
      state,
      addTransactions({
        wallet_id: 7,
        transactions: [transaction('late-old-session')],
        sessionGeneration: 1,
      })
    );
    expect(state.transactions).toEqual({});

    state = reducer(
      state,
      setTransactions({
        wallet_id: 7,
        transactions: [transaction('new-session')],
        sessionGeneration: 2,
      })
    );
    expect(state.transactions[7]).toEqual([transaction('new-session')]);
  });

  it('clears history on logout/resetWallet and keeps an older refresh from restoring it', () => {
    let state = reducer(
      undefined,
      setTransactions({
        wallet_id: 9,
        transactions: [transaction('before-logout')],
        sessionGeneration: 3,
      })
    );

    state = reducer(state, resetWallet());
    expect(state.transactions).toEqual({});

    state = reducer(
      state,
      addTransactions({
        wallet_id: 9,
        transactions: [transaction('late-after-logout')],
        sessionGeneration: 3,
      })
    );
    expect(state.transactions).toEqual({});

    // The explicit reset used by logout remains idempotent.
    state = reducer(state, resetTransactions());
    expect(state.transactions).toEqual({});
  });
});
