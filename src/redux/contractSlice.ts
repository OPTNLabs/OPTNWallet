import { createSlice, PayloadAction } from '@reduxjs/toolkit';

interface ContractInput {
  name: string;
  type: string;
  // Add other relevant fields, such as description or validation rules
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
      // console.log(
      //   'Reducer: setSelectedFunction called with payload:',
      //   action.payload
      // );
      state.selectedFunction = action.payload;
    },
    setInputs: (state, action: PayloadAction<any[]>) => {
      // console.log('Reducer: setInputs called with payload:', action.payload);
      state.inputs = action.payload;
    },
    setInputValues: (
      state,
      action: PayloadAction<{ [key: string]: string }>
    ) => {
      // console.log(
      //   'Reducer: setInputValues called with payload:',
      //   action.payload
      // );
      state.inputValues = action.payload;
    },
    resetContract: (state) => {
      Object.assign(state, initialState);
      // console.log('Reducer: Contract state has been reset.');
    },
  },
});

export const { setSelectedFunction, setInputs, setInputValues, resetContract } =
  contractSlice.actions;

export default contractSlice.reducer;
