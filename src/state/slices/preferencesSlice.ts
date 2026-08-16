import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { createSelector } from 'reselect';
import type { RootState } from '../store';
import {
  DEFAULT_EXPLORER_ID,
  type ExplorerChoice,
} from '../../utils/servers/explorers';
import type { SupportedLocale } from '../../i18n/types';

type PreferencesState = {
  locale: SupportedLocale;
  preferInternalChangeForBch: boolean;
  enableTooltips: boolean;
  // Block explorer used for "open in explorer" links. A preset id, or 'custom'
  // with user-supplied templates.
  explorerId: string;
  explorerCustomTx: string;
  explorerCustomAddress: string;
  // Transaction fee: 'auto' uses the min relay fee; 'custom' pays the user's
  // sat/byte (never below the relay minimum). Immediate effect on new txs.
  feeMode: 'auto' | 'custom';
  customFeeSatPerByte: number;
};

const initialState: PreferencesState = {
  locale: 'en',
  preferInternalChangeForBch: false,
  enableTooltips: false,
  explorerId: DEFAULT_EXPLORER_ID,
  explorerCustomTx: '',
  explorerCustomAddress: '',
  feeMode: 'auto',
  customFeeSatPerByte: 1.1,
};

const preferencesSlice = createSlice({
  name: 'preferences',
  initialState,
  reducers: {
    setLocale: (state, action: PayloadAction<SupportedLocale>) => {
      state.locale = action.payload;
    },
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
    setFeeMode: (state, action: PayloadAction<'auto' | 'custom'>) => {
      state.feeMode = action.payload;
    },
    setCustomFeeSatPerByte: (state, action: PayloadAction<number>) => {
      const value = Number(action.payload);
      state.customFeeSatPerByte =
        Number.isFinite(value) && value > 0 ? value : 1.1;
    },
  },
});

export const {
  setLocale,
  setPreferInternalChangeForBch,
  togglePreferInternalChangeForBch,
  setEnableTooltips,
  toggleEnableTooltips,
  setExplorerId,
  setExplorerCustom,
  setFeeMode,
  setCustomFeeSatPerByte,
} = preferencesSlice.actions;

export const selectLocale = (state: RootState): SupportedLocale =>
  state.preferences.locale ?? 'en';

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

export const selectFeeMode = (state: RootState): 'auto' | 'custom' =>
  state.preferences.feeMode ?? 'auto';

export const selectCustomFeeSatPerByte = (state: RootState): number =>
  state.preferences.customFeeSatPerByte ?? 1.1;

export default preferencesSlice.reducer;
