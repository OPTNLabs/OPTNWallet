import { createSlice } from '@reduxjs/toolkit';
import type { RootState } from './store';

type PreferencesState = {
  preferInternalChangeForBch: boolean;
};

const initialState: PreferencesState = {
  preferInternalChangeForBch: false,
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
  },
});

export const {
  setPreferInternalChangeForBch,
  togglePreferInternalChangeForBch,
} = preferencesSlice.actions;

export const selectPreferInternalChangeForBch = (state: RootState) =>
  state.preferences.preferInternalChangeForBch;

export default preferencesSlice.reducer;
