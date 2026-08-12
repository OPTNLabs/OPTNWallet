import { createSlice, PayloadAction } from '@reduxjs/toolkit';

interface ContractInput {
  name: string;
  type: string;
}

interface ContractState {
  selectedFunction: string | null;
  inputs: ContractInput[];
  inputValues: { [key: string]: string };
}

const initialState: ContractState = {
  selectedFunction: null,
  inputs: [],
  inputValues: {},
};

const contractSlice = createSlice({
  name: 'contract',
  initialState,
  reducers: {
    setSelectedFunction: (state, action: PayloadAction<string>) => {
      state.selectedFunction = action.payload;
    },
    setInputs: (state, action: PayloadAction<ContractInput[]>) => {
      state.inputs = action.payload;
    },
    setInputValues: (
      state,
      action: PayloadAction<{ [key: string]: string }>
    ) => {
      state.inputValues = action.payload;
    },
    resetContract: (state) => {
      Object.assign(state, initialState);
    },
  },
});

export const { setSelectedFunction, setInputs, setInputValues, resetContract } =
  contractSlice.actions;

export default contractSlice.reducer;
