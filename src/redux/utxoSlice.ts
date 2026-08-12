// src/redux/utxoSlice.ts
import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import { UTXO } from '../types/types';

interface UTXOState {
  utxos: Record<string, UTXO[]>;
  totalBalance: number;
  fetchingUTXOs: boolean;
  initialized: boolean;
}

const initialState: UTXOState = {
  utxos: {},
  totalBalance: 0,
  fetchingUTXOs: false,
  initialized: false,
};

const utxoAmount = (utxo: UTXO): number => utxo.value ?? utxo.amount ?? 0;

const sumAddressBalance = (utxos: UTXO[] | undefined): number =>
  (utxos ?? []).reduce((sum, utxo) => sum + utxoAmount(utxo), 0);

const utxoSlice = createSlice({
  name: 'utxos',
  initialState,
  reducers: {
    // Action to set UTXOs in the Redux state
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
      state.fetchingUTXOs = action.payload;
    },

    setInitialized: (state, action: PayloadAction<boolean>) => {
      state.initialized = action.payload;
    },

    // Action to reset the UTXO state
    resetUTXOs: (state) => {
      Object.assign(state, initialState);
    },

    // Action to remove specific UTXOs
    removeUTXOs: (state, action: PayloadAction<{ address: string; utxosToRemove: UTXO[] }>) => {
      const { address, utxosToRemove } = action.payload;
      if (!state.utxos[address]) return;
      const toRemove = new Set(utxosToRemove.map(u => `${u.tx_hash}-${u.tx_pos}`));
      const prevBalance = sumAddressBalance(state.utxos[address]);
      const nextUtxos = state.utxos[address].filter(
        (u) => !toRemove.has(`${u.tx_hash}-${u.tx_pos}`)
      );
      state.utxos[address] = nextUtxos;
      const nextBalance = sumAddressBalance(nextUtxos);
      state.totalBalance += nextBalance - prevBalance;
    },
  },
});

// Export actions
export const {
  setUTXOs,
  replaceAllUTXOs,
  resetUTXOs,
  updateUTXOsForAddress,
  removeUTXOs,
  setFetchingUTXOs,
  setInitialized,
} = utxoSlice.actions;

// Export reducer
export default utxoSlice.reducer;
