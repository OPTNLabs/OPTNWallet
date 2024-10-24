import { createSlice, PayloadAction } from '@reduxjs/toolkit';

export enum Network {
  CHIPNET = 'chipnet',
  MAINNET = 'mainnet',
}

interface NetworkState {
  currentNetwork: Network;
}

const initialState: NetworkState = {
  currentNetwork: Network.CHIPNET,
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
          ? Network.CHIPNET
          : Network.MAINNET;
    },
  },
});

export const { setNetwork } = networkSlice.actions;
export default networkSlice.reducer;
