import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import { UTXO } from '../../types/types';
import { resetWallet, setWalletId } from './walletSlice';

interface UTXOState {
  utxos: Record<string, UTXO[]>;
  totalBalance: number;
  fetchingUTXOs: boolean;
  initialized: boolean;
  /** 0-100 sync progress, or null when no sync is in flight. */
  syncingProgress: number | null;
  /**
   * Wall-clock start of the current Syncing session (ms since epoch).
   * Survives Home remount so the elapsed-seconds counter does not restart
   * when the user navigates away mid-sync and returns.
   */
  syncingStartedAtMs: number | null;
}

const initialState: UTXOState = {
  utxos: {},
  totalBalance: 0,
  fetchingUTXOs: false,
  initialized: false,
  syncingProgress: null,
  syncingStartedAtMs: null,
};

const utxoAmount = (utxo: UTXO): number => utxo.value ?? utxo.amount ?? 0;

const sumAddressBalance = (utxos: UTXO[] | undefined): number =>
  (utxos ?? []).reduce((sum, utxo) => sum + utxoAmount(utxo), 0);

const resetUtxoState = (state: UTXOState): void => {
  Object.assign(state, initialState);
};

const utxoSlice = createSlice({
  name: 'utxos',
  initialState,
  reducers: {
    setUTXOs: (state, action: PayloadAction<{ newUTXOs: Record<string, UTXO[]> }>) => {
      const entries = Object.entries(action.payload.newUTXOs);
      for (const [addr, list] of entries) {
        const prevBalance = sumAddressBalance(state.utxos[addr]);
        state.utxos[addr] = list;
        const nextBalance = sumAddressBalance(list);
        state.totalBalance += nextBalance - prevBalance;
      }
    },
    replaceAllUTXOs: (state, action: PayloadAction<{ utxosByAddress: Record<string, UTXO[]> }>) => {
      state.utxos = { ...action.payload.utxosByAddress };
      state.totalBalance = Object.values(state.utxos).reduce(
        (sum, list) => sum + sumAddressBalance(list),
        0
      );
    },
    updateUTXOsForAddress: (state, action: PayloadAction<{ address: string; utxos: UTXO[] }>) => {
      const { address, utxos } = action.payload;
      const prevBalance = sumAddressBalance(state.utxos[address]);
      state.utxos[address] = utxos;
      const nextBalance = sumAddressBalance(utxos);
      state.totalBalance += nextBalance - prevBalance;
    },
    setFetchingUTXOs: (state, action: PayloadAction<boolean>) => {
      const next = action.payload;
      state.fetchingUTXOs = next;
      if (next) {
        // Only stamp the start of a *new* sync. Nested setFetchingUTXOs(true)
        // while already syncing must not restart the elapsed counter.
        if (state.syncingStartedAtMs == null) {
          state.syncingStartedAtMs = Date.now();
        }
      } else {
        state.syncingStartedAtMs = null;
      }
    },
    setSyncingProgress: (state, action: PayloadAction<number | null>) => {
      state.syncingProgress =
        action.payload === null
          ? null
          : Math.max(0, Math.min(100, action.payload));
    },
    setInitialized: (state, action: PayloadAction<boolean>) => {
      state.initialized = action.payload;
    },
    resetUTXOs: (state) => {
      resetUtxoState(state);
    },
    removeUTXOs: (state, action: PayloadAction<{ address: string; utxosToRemove: UTXO[] }>) => {
      const { address, utxosToRemove } = action.payload;
      if (!state.utxos[address]) return;
      const toRemove = new Set(utxosToRemove.map((u) => `${u.tx_hash}-${u.tx_pos}`));
      const prevBalance = sumAddressBalance(state.utxos[address]);
      const nextUtxos = state.utxos[address].filter(
        (u) => !toRemove.has(`${u.tx_hash}-${u.tx_pos}`)
      );
      state.utxos[address] = nextUtxos;
      const nextBalance = sumAddressBalance(nextUtxos);
      state.totalBalance += nextBalance - prevBalance;
    },
  },
  extraReducers: (builder) => {
    // UTXOs are wallet-scoped even though this slice is a single in-memory
    // snapshot. Clear it at the action boundary before any newly opened wallet
    // can render or bootstrap, including when the next wallet currently has no
    // UTXOs of its own.
    builder.addCase(setWalletId, resetUtxoState);
    builder.addCase(resetWallet, resetUtxoState);
  },
});

export const {
  setUTXOs,
  replaceAllUTXOs,
  resetUTXOs,
  updateUTXOsForAddress,
  removeUTXOs,
  setFetchingUTXOs,
  setSyncingProgress,
  setInitialized,
} = utxoSlice.actions;

export default utxoSlice.reducer;
