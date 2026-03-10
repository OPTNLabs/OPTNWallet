import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import { TransactionHistoryItem } from '../types/types';

interface TransactionState {
  transactions: Record<string, TransactionHistoryItem[]>;
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
      action: PayloadAction<{
        wallet_id: number;
        transactions: TransactionHistoryItem[];
      }>
    ) => {
      state.transactions[action.payload.wallet_id] =
        action.payload.transactions;
    },
    addTransactions: (
      state,
      action: PayloadAction<{
        wallet_id: number;
        transactions: TransactionHistoryItem[];
      }>
    ) => {
      const currentTransactions = state.transactions[action.payload.wallet_id] || [];
      if (action.payload.transactions.length === 0) return;

      const existingByHash = new Map(
        currentTransactions.map((tx) => [tx.tx_hash, tx] as const)
      );
      const updatedTransactions: TransactionHistoryItem[] = [];

      for (const tx of action.payload.transactions) {
        const existingTx = existingByHash.get(tx.tx_hash);
        if (!existingTx) {
          updatedTransactions.push(tx);
          continue;
        }

        if (
          existingTx.height === -1 ||
          existingTx.height === 0 ||
          existingTx.height !== tx.height
        ) {
          updatedTransactions.push(tx);
        }
      }

      if (updatedTransactions.length === 0) return;
      const updatedHashes = new Set(updatedTransactions.map((tx) => tx.tx_hash));

      state.transactions[action.payload.wallet_id] = [
        ...currentTransactions.filter(
          (t) => !updatedHashes.has(t.tx_hash)
        ),
        ...updatedTransactions,
      ];
    },
    resetTransactions: (state) => {
      Object.assign(state, initialState);
    },
  },
});

export const { setTransactions, addTransactions, resetTransactions } =
  transactionSlice.actions;

export default transactionSlice.reducer;
