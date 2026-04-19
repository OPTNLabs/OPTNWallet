import { createSlice } from '@reduxjs/toolkit';
import type { RootState } from './store';

type PreferencesState = {
  preferInternalChangeForBch: boolean;
  enableTooltips: boolean;
};

const initialState: PreferencesState = {
  preferInternalChangeForBch: false,
  enableTooltips: false,
};

const preferencesSlice = createSlice({
  name: 'preferences',
  initialState,
  reducers: {
    setPreferInternalChangeForBch: (state, action: { payload: boolean }) => {
      state.preferInternalChangeForBch = action.payload;
    },
    togglePreferInternalChangeForBch: (state) => {
      state.preferInternalChangeForBch = !state.preferInternalChangeForBch;
    },
    setEnableTooltips: (state, action: { payload: boolean }) => {
      state.enableTooltips = action.payload;
    },
    toggleEnableTooltips: (state) => {
      state.enableTooltips = !state.enableTooltips;
    },
  },
});

export const {
  setPreferInternalChangeForBch,
  togglePreferInternalChangeForBch,
  setEnableTooltips,
  toggleEnableTooltips,
} = preferencesSlice.actions;

export const selectPreferInternalChangeForBch = (state: RootState) =>
  state.preferences.preferInternalChangeForBch;

export const selectTooltipsEnabled = (state: RootState) =>
  state.preferences.enableTooltips;

export default preferencesSlice.reducer;
