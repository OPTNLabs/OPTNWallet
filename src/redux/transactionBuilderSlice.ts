// src/redux/transactionBuilderSlice.ts
import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import { TransactionOutput, UTXO } from '../types/types';

interface TransactionBuilderState {
  txInputs: UTXO[];
  txOutputs: TransactionOutput[];
}

const initialState: TransactionBuilderState = {
  txInputs: [],
  txOutputs: [],
};

const transactionBuilderSlice = createSlice({
  name: 'transactionBuilder',
  initialState,
  reducers: {
    addTxInput: (state, action: PayloadAction<UTXO>) => {
      state.txInputs.push(action.payload);
    },
    removeTxInput: (state, action: PayloadAction<number>) => {
      state.txInputs = state.txInputs.filter(
        (_, index) => index !== action.payload
      );
    },
    addTxOutput: (state, action: PayloadAction<TransactionOutput>) => {
      state.txOutputs.push(action.payload);
    },
    removeTxOutput: (state, action: PayloadAction<number>) => {
      state.txOutputs = state.txOutputs.filter(
        (_, index) => index !== action.payload
      );
    },
    clearTransaction: (state) => {
      state.txInputs = [];
      state.txOutputs = [];
    },
  },
});

export const {
  addTxInput,
  removeTxInput,
  addTxOutput,
  removeTxOutput,
  clearTransaction,
} = transactionBuilderSlice.actions;

export default transactionBuilderSlice.reducer;
