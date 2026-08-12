// src/redux/priceFeedSlice.ts
import { createSlice, PayloadAction } from '@reduxjs/toolkit';

export type PriceDatum = {
  price: number;
  ts: number;
  source: 'optnlabs';
};
export type PriceFeedState = Record<string, PriceDatum | undefined>; // key = 'BTC-USD', 'BCH-USD', ...

const initialState: PriceFeedState = {};

const priceFeedSlice = createSlice({
  name: 'priceFeed',
  initialState,
  reducers: {
    // Merge-only: does not wipe keys not present in the payload
    upsertPrices: (
      state,
      action: PayloadAction<Record<string, PriceDatum>>
    ) => {
      for (const [k, v] of Object.entries(action.payload)) {
        state[k] = v;
      }
    },
    // (optional) replace-all if you still want it in some flows
    replaceAllPrices: (
      _state,
      action: PayloadAction<Record<string, PriceDatum>>
    ) => {
      return { ...action.payload };
    },
    // (optional) clear
    clearPrices: () => initialState,
  },
});

export const { upsertPrices, replaceAllPrices, clearPrices } =
  priceFeedSlice.actions;
export default priceFeedSlice.reducer;
