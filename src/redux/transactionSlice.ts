// src/redux/transactionSlice.ts
import { createSlice, PayloadAction } from '@reduxjs/toolkit';

interface Transaction {
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
      const uniqueNewTransactions = action.payload.transactions.filter(
        (tx) => !currentTransactions.find((t) => t.tx_hash === tx.tx_hash)
      );
      state.transactions[action.payload.wallet_id] = [
        ...currentTransactions,
        ...uniqueNewTransactions,
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
