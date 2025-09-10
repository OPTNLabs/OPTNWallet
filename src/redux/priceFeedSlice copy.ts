import { createSlice, PayloadAction } from '@reduxjs/toolkit';

export type PriceFeedState = Record<string, string | null>;

const priceFeedSlice = createSlice({
  name: 'priceFeed',
  initialState: {} as PriceFeedState,
  reducers: {
    updatePrices: (_, action: PayloadAction<PriceFeedState>) => action.payload,
  },
});

export const { updatePrices } = priceFeedSlice.actions;
export default priceFeedSlice.reducer;
