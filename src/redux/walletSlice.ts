import { createSlice, PayloadAction } from '@reduxjs/toolkit';

interface WalletState  {
    currentWalletId: string;
};

const initialState : WalletState = {
    currentWalletId: "",
};

const walletSlice = createSlice({
    name: "wallet_id",
    initialState,
    reducers: {
        setWalletId: (state, action: PayloadAction<string>) => {
            state.currentWalletId = action.payload;
        }
    }
})

export const { setWalletId } = walletSlice.actions;

export default walletSlice.reducer;