import { createSlice, PayloadAction } from '@reduxjs/toolkit';

export type PriceDatum = {
  price: number;
  ts: number;
  source: 'optnlabs';
};
export type PriceFeedState = Record<string, PriceDatum | undefined>;

const initialState: PriceFeedState = {};

const priceFeedSlice = createSlice({
  name: 'priceFeed',
  initialState,
  reducers: {
    upsertPrices: (state, action: PayloadAction<Record<string, PriceDatum>>) => {
      for (const [k, v] of Object.entries(action.payload)) {
        state[k] = v;
      }
    },
    replaceAllPrices: (_state, action: PayloadAction<Record<string, PriceDatum>>) => {
      return { ...action.payload };
    },
    clearPrices: () => initialState,
  },
});

export const { upsertPrices, replaceAllPrices, clearPrices } =
  priceFeedSlice.actions;
export default priceFeedSlice.reducer;
