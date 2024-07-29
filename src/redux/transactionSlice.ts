import { createSlice, PayloadAction } from '@reduxjs/toolkit';

export interface Transaction {
  tx_hash: string;
  height: number;
  timestamp: string;
  amount: number;
}

interface TransactionState {
  transactions: Record<string, Transaction[]>;
}

const initialState: TransactionState = {
  transactions: {},
};

const transactionSlice = createSlice({
  name: 'transactions',
  initialState,
  reducers: {
    setTransactions: (
      state,
      action: PayloadAction<{ wallet_id: number; transactions: Transaction[] }>
    ) => {
      state.transactions[action.payload.wallet_id] =
        action.payload.transactions;
    },
    addTransactions: (
      state,
      action: PayloadAction<{ wallet_id: number; transactions: Transaction[] }>
    ) => {
      const currentTransactions =
        state.transactions[action.payload.wallet_id] || [];
      const updatedTransactions = action.payload.transactions.reduce(
        (acc, tx) => {
          const existingTx = currentTransactions.find(
            (t) => t.tx_hash === tx.tx_hash
          );
          if (existingTx) {
            if (
              existingTx.height === -1 ||
              existingTx.height === 0 ||
              existingTx.height !== tx.height
            ) {
              return acc.concat(tx);
            } else {
              return acc;
            }
          } else {
            return acc.concat(tx);
          }
        },
        [] as Transaction[]
      );
      state.transactions[action.payload.wallet_id] = [
        ...currentTransactions.filter(
          (t) => !updatedTransactions.find((utx) => utx.tx_hash === t.tx_hash)
        ),
        ...updatedTransactions,
      ];
    },
    resetTransactions: (state) => {
      state.transactions = {};
    },
  },
});

export const { setTransactions, addTransactions, resetTransactions } =
  transactionSlice.actions;

export default transactionSlice.reducer;
