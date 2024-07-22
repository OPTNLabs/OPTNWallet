import { createSlice, PayloadAction } from '@reduxjs/toolkit';

interface ContractState {
  selectedFunction: string | null;
  inputs: any[];
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
    setSelectedFunction(state, action: PayloadAction<string>) {
      state.selectedFunction = action.payload;
    },
    setInputs(state, action: PayloadAction<any[]>) {
      state.inputs = action.payload;
    },
    setInputValues(state, action: PayloadAction<{ [key: string]: string }>) {
      state.inputValues = action.payload;
    },
  },
});

export const { setSelectedFunction, setInputs, setInputValues } =
  contractSlice.actions;
export default contractSlice.reducer;
