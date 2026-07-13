import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { createSelector } from 'reselect';
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

// Memoized with createSelector so these return stable references. A selector
// that builds a fresh object on every call breaks React-Redux's
// useSyncExternalStore and can trigger an infinite render loop in any component
// that reads it.
export const selectExplorerId = (state: RootState) =>
  state.preferences.explorerId ?? DEFAULT_EXPLORER_ID;

// Resolves persisted preference (older state has no explorer fields) into the
// ExplorerChoice the URL builders take.
export const selectExplorerChoice = createSelector(
  [
    selectExplorerId,
    (state: RootState) => state.preferences.explorerCustomTx,
    (state: RootState) => state.preferences.explorerCustomAddress,
  ],
  (id, customTx, customAddress): ExplorerChoice =>
    id === 'custom'
      ? { kind: 'custom', tx: customTx || '', address: customAddress || '' }
      : { kind: 'preset', id }
);

export const selectExplorerCustom = createSelector(
  [
    (state: RootState) => state.preferences.explorerCustomTx,
    (state: RootState) => state.preferences.explorerCustomAddress,
  ],
  (tx, address) => ({ tx: tx ?? '', address: address ?? '' })
);

export default preferencesSlice.reducer;
