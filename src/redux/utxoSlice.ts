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

// Helper to calculate total balance from UTXOs
const calculateTotalBalance = (utxos: Record<string, UTXO[]>) =>
  Object.values(utxos)
    .flat()
    .reduce((sum, utxo: any) => sum + (utxo.value ?? utxo.amount ?? 0), 0);

const utxoSlice = createSlice({
  name: 'utxos',
  initialState,
  reducers: {
    // Action to set UTXOs in the Redux state
    setUTXOs: (state, action: PayloadAction<{ newUTXOs: Record<string, UTXO[]> }>) => {
      const entries = Object.entries(action.payload.newUTXOs);
      console.log('[utxoSlice] setUTXOs MERGE keys=', entries.map(([k]) => k));
      for (const [addr, list] of entries) {
        state.utxos[addr] = list;
      }
      state.totalBalance = calculateTotalBalance(state.utxos);
      console.log('[utxoSlice] setUTXOs totalBalance=', state.totalBalance);
    },

     replaceAllUTXOs: (state, action: PayloadAction<{ utxosByAddress: Record<string, UTXO[]> }>) => {
      console.log('[utxoSlice] replaceAllUTXOs keys=', Object.keys(action.payload.utxosByAddress));
      state.utxos = { ...action.payload.utxosByAddress };
      state.totalBalance = calculateTotalBalance(state.utxos);
      console.log('[utxoSlice] replaceAllUTXOs totalBalance=', state.totalBalance);
    },

    updateUTXOsForAddress: (state, action: PayloadAction<{ address: string; utxos: UTXO[] }>) => {
      const { address, utxos } = action.payload;
      const prevLen = state.utxos[address]?.length ?? 0;
      console.log('[utxoSlice] updateUTXOsForAddress addr=', address, 'prevLen=', prevLen, 'newLen=', utxos.length);
      state.utxos[address] = utxos;
      state.totalBalance = calculateTotalBalance(state.utxos);
      console.log('[utxoSlice] totalBalance after update=', state.totalBalance);
    },

    setFetchingUTXOs: (state, action: PayloadAction<boolean>) => {
      console.log('[utxoSlice] setFetchingUTXOs =>', action.payload);
      state.fetchingUTXOs = action.payload;
    },

    setInitialized: (state, action: PayloadAction<boolean>) => {
      console.log('[utxoSlice] setInitialized =>', action.payload);
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
      state.utxos[address] = state.utxos[address].filter(u => !toRemove.has(`${u.tx_hash}-${u.tx_pos}`));
      state.totalBalance = calculateTotalBalance(state.utxos);
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
