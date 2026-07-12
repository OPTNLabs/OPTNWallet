import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { RootState } from '../store';
import { DEFAULT_EXPLORER_ID, type ExplorerChoice } from '../../utils/servers/explorers';

type PreferencesState = {
  preferInternalChangeForBch: boolean;
  enableTooltips: boolean;
  // Block explorer used for "open in explorer" links. A preset id, or 'custom'
  // with user-supplied templates.
  explorerId: string;
  explorerCustomTx: string;
  explorerCustomAddress: string;
};

const initialState: PreferencesState = {
  preferInternalChangeForBch: false,
  enableTooltips: false,
  explorerId: DEFAULT_EXPLORER_ID,
  explorerCustomTx: '',
  explorerCustomAddress: '',
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
    setExplorerId: (state, action: PayloadAction<string>) => {
      state.explorerId = action.payload;
    },
    setExplorerCustom: (
      state,
      action: PayloadAction<{ tx: string; address: string }>
    ) => {
      state.explorerId = 'custom';
      state.explorerCustomTx = action.payload.tx.trim();
      state.explorerCustomAddress = action.payload.address.trim();
    },
  },
});

export const {
  setPreferInternalChangeForBch,
  togglePreferInternalChangeForBch,
  setEnableTooltips,
  toggleEnableTooltips,
  setExplorerId,
  setExplorerCustom,
} = preferencesSlice.actions;

export const selectPreferInternalChangeForBch = (state: RootState) =>
  state.preferences.preferInternalChangeForBch;

export const selectTooltipsEnabled = (state: RootState) =>
  state.preferences.enableTooltips;

// Resolves persisted preference (older state has no explorer fields) into the
// ExplorerChoice the URL builders take.
export const selectExplorerChoice = (state: RootState): ExplorerChoice => {
  const id = state.preferences.explorerId ?? DEFAULT_EXPLORER_ID;
  if (id === 'custom') {
    return {
      kind: 'custom',
      tx: state.preferences.explorerCustomTx || '',
      address: state.preferences.explorerCustomAddress || '',
    };
  }
  return { kind: 'preset', id };
};

export const selectExplorerId = (state: RootState) =>
  state.preferences.explorerId ?? DEFAULT_EXPLORER_ID;
export const selectExplorerCustom = (state: RootState) => ({
  tx: state.preferences.explorerCustomTx ?? '',
  address: state.preferences.explorerCustomAddress ?? '',
});

export default preferencesSlice.reducer;
