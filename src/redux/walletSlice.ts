// src/redux/walletSlice.ts
import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import { Network } from './networkSlice';
import type { RootState } from './store';
import { WalletType } from '../types/wallet';

export interface WalletState {
  currentWalletId: number;
  networkType: Network;
  walletType: WalletType;
}

const initialState: WalletState = {
  currentWalletId: 0,
  networkType: Network.CHIPNET,
  walletType: WalletType.STANDARD,
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
    setWalletType: (state, action: PayloadAction<WalletType>) => {
      state.walletType = action.payload;
    },
  },
});

export const { setWalletId, resetWallet, setWalletNetwork, setWalletType } =
  walletSlice.actions;

export default walletSlice.reducer;

// Selectors
export const selectWalletId = (state: RootState) => state.wallet_id.currentWalletId;
export const selectHasWallet = (state: RootState) =>
  state.wallet_id.currentWalletId > 0;
export const selectNetworkType = (state: RootState) => state.wallet_id.networkType;
export const selectWalletType = (state: RootState) => state.wallet_id.walletType;
