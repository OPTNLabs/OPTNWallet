import { createSlice, PayloadAction } from '@reduxjs/toolkit';

export enum Network {
  CHIPNET = 'chipnet',
  MAINNET = 'mainnet',
}



interface NetworkState {
  currentNetwork: Network;
}

const initialState: NetworkState = {
  currentNetwork: Network.MAINNET,
};

const networkSlice = createSlice({
  name: 'network',
  initialState,
  reducers: {
    setNetwork: (state, action: PayloadAction<Network>) => {
      state.currentNetwork = action.payload;
    },
    toggleNetwork: (state) => {
      state.currentNetwork =
        state.currentNetwork === Network.MAINNET
          ? Network.MAINNET
          : Network.CHIPNET;
    },
    resetNetwork: (state) => {
      Object.assign(state, initialState);
    },
  },
});

export const { setNetwork, resetNetwork, toggleNetwork } = networkSlice.actions;
export default networkSlice.reducer;
