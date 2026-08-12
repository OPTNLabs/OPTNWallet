// src/redux/transactionBuilderSlice.ts

import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import { TransactionOutput } from '../types/types';

interface TransactionBuilderState {
  txOutputs: TransactionOutput[];
}

const initialState: TransactionBuilderState = {
  txOutputs: [],
};

const transactionBuilderSlice = createSlice({
  name: 'transactionBuilder',
  initialState,
  reducers: {
    addTxOutput: (state, action: PayloadAction<TransactionOutput>) => {
      // console.log('Reducer: addTxOutput called with payload:', action.payload);
      state.txOutputs.push(action.payload);
      // console.log('Reducer: txOutputs after addTxOutput:', state.txOutputs);
    },
    removeTxOutput: (state, action: PayloadAction<number>) => {
      // console.log('Reducer: removeTxOutput called with index:', action.payload);
      state.txOutputs.splice(action.payload, 1);
      // console.log('Reducer: txOutputs after removeTxOutput:', state.txOutputs);
    },
    clearTransaction: (state) => {
      Object.assign(state, initialState);
      // console.log(
      //   'Reducer: txOutputs after clearTransaction:',
      //   state.txOutputs
      // );
    },
    setTxOutputs: (state, action: PayloadAction<TransactionOutput[]>) => {
      // console.log('Reducer: setTxOutputs called with payload:', action.payload);
      state.txOutputs = action.payload;
      // console.log('Reducer: txOutputs after setTxOutputs:', state.txOutputs);
    },
  },
});

export const { addTxOutput, removeTxOutput, clearTransaction, setTxOutputs } =
  transactionBuilderSlice.actions;

export default transactionBuilderSlice.reducer;
