import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { createSelector } from 'reselect';
import type { RootState } from '../store';
import {
  DEFAULT_EXPLORER_ID,
  type ExplorerChoice,
} from '../../utils/servers/explorers';
import type { SupportedLocale } from '../../i18n/types';

export const DEFAULT_MERCHANT_PAY_CONVERSION_BPS = 10_000;

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
  /** Default share of an incoming Merchant Pay amount converted to the other asset. */
  merchantPayDefaultConversionBps: number;
  // The chain connection policy, mirrored from the Rust runtime so explorer
  // links obey it. Not a preference the user sets here -- it is set in Chain
  // Sources, read back from the runtime, and kept because it is persisted:
  // without that, a restart would briefly treat "own infrastructure only" as
  // Auto and allow exactly the public lookup that policy forbids.
  chainPolicy: string;
  // Desktop update channels. Two independent opt-ins, both off, because that
  // is what they mean: beta adds builds cut from staging and alpha adds the
  // unfinished ones. Someone who ticks both is on alpha, which includes beta.
  updateBeta: boolean;
  updateAlpha: boolean;
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
  merchantPayDefaultConversionBps: DEFAULT_MERCHANT_PAY_CONVERSION_BPS,
  chainPolicy: 'auto',
  updateBeta: false,
  updateAlpha: false,
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
    setChainPolicy: (state, action: PayloadAction<string>) => {
      state.chainPolicy = action.payload;
    },
    setUpdateBeta: (state, action: PayloadAction<boolean>) => {
      state.updateBeta = action.payload;
    },
    setUpdateAlpha: (state, action: PayloadAction<boolean>) => {
      state.updateAlpha = action.payload;
    },
    setMerchantPayDefaultConversionBps: (
      state,
      action: PayloadAction<number>
    ) => {
      const value = Number(action.payload);
      state.merchantPayDefaultConversionBps = Number.isFinite(value)
        ? Math.min(10_000, Math.max(0, Math.round(value)))
        : DEFAULT_MERCHANT_PAY_CONVERSION_BPS;
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
  setChainPolicy,
  setUpdateBeta,
  setUpdateAlpha,
  setMerchantPayDefaultConversionBps,
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

// Default false on state persisted before these existed: never opt someone
// into pre-release builds by upgrading them.
export const selectUpdateBeta = (state: RootState): boolean =>
  state.preferences.updateBeta ?? false;

export const selectUpdateAlpha = (state: RootState): boolean =>
  state.preferences.updateAlpha ?? false;

// Falls back to the fail-closed reading, not to 'auto': state persisted before
// this field existed says nothing about the policy, and guessing "public is
// fine" is the one guess that can leak.
export const selectChainPolicy = (state: RootState): string =>
  state.preferences.chainPolicy ?? 'own_infrastructure';

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

export const selectMerchantPayDefaultConversionBps = (
  state: RootState
): number => {
  const value = Number(state.preferences.merchantPayDefaultConversionBps);
  return Number.isFinite(value)
    ? Math.min(10_000, Math.max(0, Math.round(value)))
    : DEFAULT_MERCHANT_PAY_CONVERSION_BPS;
};

export default preferencesSlice.reducer;
