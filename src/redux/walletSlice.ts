// src/redux/walletSlice.ts
import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import { Network } from './networkSlice';

interface WalletState {
  currentWalletId: number;
  networkType: Network;
}

const initialState: WalletState = {
  currentWalletId: 0,
  networkType: Network.CHIPNET,
};

const walletSlice = createSlice({
  name: 'wallet_id',
  initialState,
  reducers: {
    setWalletId: (state, action: PayloadAction<number>) => {
      state.currentWalletId = action.payload;
    },
    resetWallet: (state) => {
      Object.assign(state, initialState);
    },
    setWalletNetwork: (state, action: PayloadAction<Network>) => {
      state.networkType = action.payload;
    },
  },
});

export const { setWalletId, resetWallet, setWalletNetwork } =
  walletSlice.actions;

export default walletSlice.reducer;

// Selectors
export const selectWalletId = (state: { wallet_id: WalletState }) =>
  state.wallet_id.currentWalletId;
export const selectNetworkType = (state: { wallet_id: WalletState }) =>
  state.wallet_id.networkType;
