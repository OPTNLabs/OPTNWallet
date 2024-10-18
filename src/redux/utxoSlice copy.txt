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
      action: PayloadAction<{ newUTXOs: Record<string, UTXO[]> }>
    ) => {
      const newUTXOs = action.payload.newUTXOs;

      // Update state with new UTXOs
      Object.keys(newUTXOs).forEach((address) => {
        state.utxos[address] = newUTXOs[address];
        // .filter(
        //   (utxo) => utxo.height !== 0
        // );
      });

      // Remove UTXOs that do not match any of the "tx_hash" from the new UTXOs
      Object.keys(state.utxos).forEach((address) => {
        state.utxos[address] = state.utxos[address].filter((utxo) =>
          newUTXOs[address]?.some((newUtxo) => newUtxo.tx_hash === utxo.tx_hash)
        );
      });

      state.totalBalance = calculateTotalBalance(state.utxos);
    },
    resetUTXOs: (state) => {
      Object.assign(state, initialState);
    },
  },
});

export const { setUTXOs, resetUTXOs } = utxoSlice.actions;

export default utxoSlice.reducer;
