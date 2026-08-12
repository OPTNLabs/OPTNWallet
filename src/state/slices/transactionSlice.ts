import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import { TransactionHistoryItem } from '../../types/types';
import { preferHistoryHeight } from '../../utils/txConfirmation';
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

function normalizeTxHash(hash: string): string {
  return String(hash ?? '')
    .trim()
    .toLowerCase();
}

/** Keep fusion inject timestamps; never let height 0 erase a confirmed height. */
function mergeHistoryItem(
  incoming: TransactionHistoryItem,
  existing?: TransactionHistoryItem
): TransactionHistoryItem {
  const tx_hash = normalizeTxHash(incoming.tx_hash);
  const incomingTs =
    incoming.timestamp != null && String(incoming.timestamp).trim() !== ''
      ? String(incoming.timestamp)
      : undefined;
  const existingTs =
    existing?.timestamp != null && String(existing.timestamp).trim() !== ''
      ? String(existing.timestamp)
      : undefined;
  return {
    ...incoming,
    tx_hash,
    height: preferHistoryHeight(incoming.height, existing?.height),
    timestamp: incomingTs ?? existingTs,
  };
}

const transactionSlice = createSlice({
  name: 'transactions',
  initialState,
  reducers: {
    setTransactions: (state, action: PayloadAction<TransactionWritePayload>) => {
      if (!acceptsSessionWrite(state, action.payload.sessionGeneration)) return;
      const prev = state.transactions[action.payload.wallet_id] ?? [];
      const prevByHash = new Map(
        prev.map((tx) => [normalizeTxHash(tx.tx_hash), tx] as const)
      );
      // Electrum full refresh: keep prior timestamps (e.g. fusion inject) so
      // newest-first sort does not bury a just-fused CoinJoin mid-list.
      state.transactions[action.payload.wallet_id] =
        action.payload.transactions.map((tx) =>
          mergeHistoryItem(tx, prevByHash.get(normalizeTxHash(tx.tx_hash)))
        );
    },
    addTransactions: (state, action: PayloadAction<TransactionWritePayload>) => {
      if (!acceptsSessionWrite(state, action.payload.sessionGeneration)) return;
      const currentTransactions =
        state.transactions[action.payload.wallet_id] || [];
      if (action.payload.transactions.length === 0) return;

      const existingByHash = new Map(
        currentTransactions.map(
          (tx) => [normalizeTxHash(tx.tx_hash), tx] as const
        )
      );
      const updatedTransactions: TransactionHistoryItem[] = [];

      for (const raw of action.payload.transactions) {
        const hash = normalizeTxHash(raw.tx_hash);
        const existingTx = existingByHash.get(hash);
        const tx = mergeHistoryItem(raw, existingTx);
        if (!existingTx) {
          updatedTransactions.push(tx);
          continue;
        }

        if (
          existingTx.height === -1 ||
          existingTx.height === 0 ||
          tx.height > existingTx.height ||
          (!!tx.timestamp && tx.timestamp !== existingTx.timestamp)
        ) {
          updatedTransactions.push(tx);
        }
      }

      if (updatedTransactions.length === 0) return;
      const updatedHashes = new Set(
        updatedTransactions.map((t) => normalizeTxHash(t.tx_hash))
      );

      state.transactions[action.payload.wallet_id] = [
        ...currentTransactions.filter(
          (t) => !updatedHashes.has(normalizeTxHash(t.tx_hash))
        ),
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
