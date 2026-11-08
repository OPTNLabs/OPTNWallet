import { createSlice, PayloadAction } from '@reduxjs/toolkit';

/**
 * Wire, storage and Redux name of each network. The values match the Rust
 * `optn_core::network::Network` names, so they cross the desktop bridge as-is.
 * Everything else about a network lives in `utils/networkProfile.ts`.
 */
export enum Network {
  CHIPNET = 'chipnet',
  MAINNET = 'mainnet',
  TESTNET3 = 'testnet3',
  TESTNET4 = 'testnet4',
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
    resetNetwork: (state) => {
      Object.assign(state, initialState);
    },
  },
});

export const { setNetwork, resetNetwork } = networkSlice.actions;
export default networkSlice.reducer;
