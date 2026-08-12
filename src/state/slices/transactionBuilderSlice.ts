import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import { TransactionOutput } from '../../types/types';

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
      state.txOutputs.push(action.payload);
    },
    removeTxOutput: (state, action: PayloadAction<number>) => {
      state.txOutputs.splice(action.payload, 1);
    },
    clearTransaction: (state) => {
      Object.assign(state, initialState);
    },
    setTxOutputs: (state, action: PayloadAction<TransactionOutput[]>) => {
      state.txOutputs = action.payload;
    },
  },
});

export const { addTxOutput, removeTxOutput, clearTransaction, setTxOutputs } =
  transactionBuilderSlice.actions;

export default transactionBuilderSlice.reducer;
