import { createSlice, PayloadAction } from '@reduxjs/toolkit';

interface WalletState {
  currentWalletId: number;
};

const initialState: WalletState = {
  currentWalletId: 0, // Initialize with a default integer value
};

const walletSlice = createSlice({
  name: "wallet_id",
  initialState,
  reducers: {
    setWalletId: (state, action: PayloadAction<number>) => {
      state.currentWalletId = action.payload;
    }
  }
});

export const { setWalletId } = walletSlice.actions;

export default walletSlice.reducer;
