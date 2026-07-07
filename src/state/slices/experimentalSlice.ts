import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import type { RootState } from '../store';

const DEFAULT_FUSION_SERVER = 'cashfusion.electroncash.dk:8787';

interface ExperimentalState {
  rpaEnabled: boolean;
  cashFusionEnabled: boolean;
  fusionServer: string;
}

const initialState: ExperimentalState = {
  rpaEnabled: false,
  cashFusionEnabled: false,
  fusionServer: DEFAULT_FUSION_SERVER,
};

const experimentalSlice = createSlice({
  name: 'experimental',
  initialState,
  reducers: {
    setRpaEnabled(state, action: PayloadAction<boolean>) {
      state.rpaEnabled = action.payload;
    },
    setCashFusionEnabled(state, action: PayloadAction<boolean>) {
      state.cashFusionEnabled = action.payload;
    },
    setFusionServer(state, action: PayloadAction<string>) {
      state.fusionServer = action.payload;
    },
  },
});

export const { setRpaEnabled, setCashFusionEnabled, setFusionServer } = experimentalSlice.actions;
export const selectRpaEnabled = (state: RootState) => state.experimental.rpaEnabled;
export const selectCashFusionEnabled = (state: RootState) => state.experimental.cashFusionEnabled;
export const selectFusionServer = (state: RootState) => state.experimental.fusionServer;
export default experimentalSlice.reducer;
