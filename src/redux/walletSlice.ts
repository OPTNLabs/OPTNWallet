// src/redux/walletSlice.ts
import { createSlice, PayloadAction } from '@reduxjs/toolkit';

interface WalletState {
  currentWalletId: number;
}

const initialState: WalletState = {
  currentWalletId: 0,
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
  },
});

export const { setWalletId, resetWallet } = walletSlice.actions;

export default walletSlice.reducer;
