import { createSlice, PayloadAction } from '@reduxjs/toolkit';

type AssetData = {
  id: string;
  rank: string;
  symbol: string;
  name: string;
  supply: string;
  maxSupply: string;
  marketCapUsd: string;
  volumeUsd24Hr: string;
  priceUsd: string;
  changePercent24Hr: string;
  vwap24Hr: string;
};

type PriceFeedState = Record<string, AssetData>;

const priceFeedSlice = createSlice({
  name: 'priceFeed',
  initialState: {} as PriceFeedState,
  reducers: {
    updatePrices: (_, action: PayloadAction<PriceFeedState>) => {
      return { ...action.payload }; // Replace with the latest prices
    },
  },
});

export const { updatePrices } = priceFeedSlice.actions;
export default priceFeedSlice.reducer;
