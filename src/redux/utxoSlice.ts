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
    .reduce((sum, utxo) => sum + utxo.amount, 0);

const utxoSlice = createSlice({
  name: 'utxos',
  initialState,
  reducers: {
    // Action to set UTXOs in the Redux state
    setUTXOs: (
      state,
      action: PayloadAction<{ newUTXOs: Record<string, UTXO[]> }>
    ) => {
      const newUTXOs = action.payload.newUTXOs;

      // Update state with new UTXOs, merging them with existing ones
      Object.keys(newUTXOs).forEach((address) => {
        state.utxos[address] = newUTXOs[address];
      });

      // Clean up: remove UTXOs that no longer exist in the new set
      Object.keys(state.utxos).forEach((address) => {
        state.utxos[address] = state.utxos[address].filter((utxo) =>
          newUTXOs[address]?.some(
            (newUtxo) =>
              newUtxo.tx_hash === utxo.tx_hash && newUtxo.tx_pos === utxo.tx_pos
          )
        );
      });

      // Recalculate the total balance
      state.totalBalance = calculateTotalBalance(state.utxos);
    },

    // Action to reset the UTXO state
    resetUTXOs: (state) => {
      Object.assign(state, initialState);
    },

    // Action to update UTXOs for a specific address
    updateUTXOsForAddress: (
      state,
      action: PayloadAction<{ address: string; utxos: UTXO[] }>
    ) => {
      const { address, utxos } = action.payload;
      state.utxos[address] = utxos;

      // Recalculate the total balance
      state.totalBalance = calculateTotalBalance(state.utxos);
    },

    // Action to remove specific UTXOs
    removeUTXOs: (
      state,
      action: PayloadAction<{ address: string; utxosToRemove: UTXO[] }>
    ) => {
      const { address, utxosToRemove } = action.payload;
      const utxoKeysToRemove = new Set(
        utxosToRemove.map((utxo) => `${utxo.tx_hash}-${utxo.tx_pos}`)
      );

      state.utxos[address] = state.utxos[address].filter(
        (utxo) => !utxoKeysToRemove.has(`${utxo.tx_hash}-${utxo.tx_pos}`)
      );

      // Recalculate the total balance
      state.totalBalance = calculateTotalBalance(state.utxos);
    },

    // Action to set fetchingUTXOs state
    setFetchingUTXOs: (state, action: PayloadAction<boolean>) => {
      state.fetchingUTXOs = action.payload;
    },

    setInitialized: (state, action: PayloadAction<boolean>) => {
      state.initialized = action.payload;
    },
  },
});

// Export actions
export const {
  setUTXOs,
  resetUTXOs,
  updateUTXOsForAddress,
  removeUTXOs,
  setFetchingUTXOs,
  setInitialized,
} = utxoSlice.actions;

// Export reducer
export default utxoSlice.reducer;
