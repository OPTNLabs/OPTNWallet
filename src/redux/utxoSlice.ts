// src/redux/utxoSlice.ts
import { createSlice, PayloadAction } from '@reduxjs/toolkit';

interface UTXO {
  tx_hash: string;
  tx_pos: number;
  amount: number;
  address: string;
  height: number;
  token_data: { amount: string; category: string } | null;
  privateKeyBase64: string; // Store the privateKey as a Base64 string
}

interface UTXOState {
  utxos: Record<string, UTXO[]>;
  totalBalance: number;
}

const initialState: UTXOState = {
  utxos: {},
  totalBalance: 0,
};

const calculateTotalBalance = (utxos: Record<string, UTXO[]>) => {
  return Object.values(utxos)
    .flat()
    .reduce((sum, utxo) => sum + utxo.amount, 0);
};

const utxoSlice = createSlice({
  name: 'utxos',
  initialState,
  reducers: {
    setUTXOs: (
      state,
      action: PayloadAction<{ address: string; utxos: UTXO[] }>
    ) => {
      state.utxos[action.payload.address] = action.payload.utxos;
      state.totalBalance = calculateTotalBalance(state.utxos);
    },
    clearUTXOs: (state) => {
      state.utxos = {};
      state.totalBalance = 0;
    },
    resetUTXOs: (state) => {
      Object.assign(state, initialState);
    },
  },
});

export const { setUTXOs, clearUTXOs, resetUTXOs } = utxoSlice.actions;

export default utxoSlice.reducer;
