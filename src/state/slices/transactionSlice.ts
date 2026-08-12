import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import { TransactionHistoryItem } from '../../types/types';
import { resetWallet, setWalletId } from './walletSlice';

interface TransactionState {
  transactions: Record<string, TransactionHistoryItem[]>;
  /** Monotonic barrier matching wallet session changes. */
  sessionGeneration: number;
}

const initialState: TransactionState = {
  transactions: {},
  sessionGeneration: 0,
};

type TransactionWritePayload = {
  wallet_id: number;
  transactions: TransactionHistoryItem[];
  /** Writes from async work must identify the wallet session that started them. */
  sessionGeneration?: number;
};

function acceptsSessionWrite(
  state: TransactionState,
  sessionGeneration: number | undefined
): boolean {
  if (sessionGeneration === undefined) return true;

  const currentGeneration = state.sessionGeneration ?? 0;
  if (sessionGeneration < currentGeneration) return false;

  if (sessionGeneration > currentGeneration) {
    state.transactions = {};
    state.sessionGeneration = sessionGeneration;
  }

  return true;
}

function resetTransactionState(state: TransactionState): void {
  state.transactions = {};
}

const transactionSlice = createSlice({
  name: 'transactions',
  initialState,
  reducers: {
    setTransactions: (state, action: PayloadAction<TransactionWritePayload>) => {
      if (
        !acceptsSessionWrite(state, action.payload.sessionGeneration)
      ) return;
      state.transactions[action.payload.wallet_id] =
        action.payload.transactions;
    },
    addTransactions: (state, action: PayloadAction<TransactionWritePayload>) => {
      if (
        !acceptsSessionWrite(state, action.payload.sessionGeneration)
      ) return;
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
        ...currentTransactions.filter((t) => !updatedHashes.has(t.tx_hash)),
        ...updatedTransactions,
      ];
    },
    resetTransactions: (state) => {
      resetTransactionState(state);
    },
  },
  extraReducers: (builder) => {
    // Transaction history is a single in-memory snapshot keyed by wallet id.
    // Clear it at the wallet boundary so the next wallet/path/network cannot
    // render the previous session while its first scan is still pending.
    builder.addCase(setWalletId, (state) => {
      resetTransactionState(state);
      state.sessionGeneration = (state.sessionGeneration ?? 0) + 1;
    });
    builder.addCase(resetWallet, (state) => {
      resetTransactionState(state);
      state.sessionGeneration = (state.sessionGeneration ?? 0) + 1;
    });
  },
});

export const { setTransactions, addTransactions, resetTransactions } =
  transactionSlice.actions;

export default transactionSlice.reducer;
