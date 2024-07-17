// src/redux/utxoSlice.ts
import { createSlice, PayloadAction } from '@reduxjs/toolkit';

interface UTXO {
  tx_hash: string;
  tx_pos: number;
  amount: number;
  address: string;
  height: number;
  token_data: { amount: string; category: string } | null;
}

interface UTXOState {
  utxos: Record<string, UTXO[]>;
}

const initialState: UTXOState = {
  utxos: {},
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
    },
    clearUTXOs: (state) => {
      state.utxos = {};
    },
  },
});

export const { setUTXOs, clearUTXOs } = utxoSlice.actions;

export default utxoSlice.reducer;
