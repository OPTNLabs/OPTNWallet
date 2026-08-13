import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import type { WalletSpecialActivityRecord } from '../../services/WalletSpecialActivityService';
import { resetWallet, setWalletId } from './walletSlice';

export type WalletSpecialActivityState = {
  byWallet: Record<number, Partial<Record<WalletSpecialActivityRecord['activityType'], WalletSpecialActivityRecord>>>;
};

const initialState: WalletSpecialActivityState = {
  byWallet: {},
};

const walletSpecialActivitySlice = createSlice({
  name: 'walletSpecialActivity',
  initialState,
  reducers: {
    setWalletSpecialActivity: (
      state,
      action: PayloadAction<{
        walletId: number;
        record: WalletSpecialActivityRecord;
      }>
    ) => {
      const current = state.byWallet[action.payload.walletId] ?? {};
      state.byWallet[action.payload.walletId] = {
        ...current,
        [action.payload.record.activityType]: action.payload.record,
      };
    },
    clearWalletSpecialActivities: (state, action: PayloadAction<number>) => {
      delete state.byWallet[action.payload];
    },
    resetWalletSpecialActivities: (state) => {
      state.byWallet = {};
    },
  },
  extraReducers: (builder) => {
    builder.addCase(setWalletId, (state, action) => {
      // The active wallet can keep the same id during a session-generation
      // bump, so only clear records when the wallet id actually changes.
      const activeWalletIds = Object.keys(state.byWallet).map(Number);
      for (const walletId of activeWalletIds) {
        if (walletId !== action.payload) delete state.byWallet[walletId];
      }
    });
    builder.addCase(resetWallet, (state) => {
      state.byWallet = {};
    });
  },
});

export const {
  setWalletSpecialActivity,
  clearWalletSpecialActivities,
  resetWalletSpecialActivities,
} = walletSpecialActivitySlice.actions;

export const selectWalletSpecialActivity = (
  state: { walletSpecialActivity: WalletSpecialActivityState },
  walletId: number | null | undefined,
  activityType: WalletSpecialActivityRecord['activityType']
): WalletSpecialActivityRecord | null => {
  if (!walletId) return null;
  return state.walletSpecialActivity.byWallet[walletId]?.[activityType] ?? null;
};

/** Sum stealth sats from a stored RPA payload (field or output list). */
export function rpaPayloadStealthSats(payload: unknown): number {
  if (!payload || typeof payload !== 'object') return 0;
  const record = payload as {
    unspentSats?: unknown;
    unspentOutputs?: Array<{ valueSats?: unknown }>;
  };
  const fromField = Number(record.unspentSats);
  const fromOutputs = Array.isArray(record.unspentOutputs)
    ? record.unspentOutputs.reduce(
        (sum, output) => sum + (Number(output.valueSats) || 0),
        0
      )
    : 0;
  const sats = Math.max(
    Number.isFinite(fromField) ? fromField : 0,
    fromOutputs
  );
  return sats > 0 ? sats : 0;
}

/** Stealth BCH sats already claimed/scanned for this wallet. Not in UTXO total. */
export const selectRpaStealthSats = (
  state: { walletSpecialActivity?: WalletSpecialActivityState },
  walletId: number | null | undefined
): number => {
  const numericId = Number(walletId);
  if (!Number.isInteger(numericId) || numericId <= 0) return 0;
  const byWallet = state.walletSpecialActivity?.byWallet;
  if (!byWallet) return 0;
  const record =
    byWallet[numericId]?.rpa ??
    byWallet[String(numericId) as unknown as number]?.rpa ??
    null;
  if (!record) return 0;
  return rpaPayloadStealthSats(record.payload);
};

export default walletSpecialActivitySlice.reducer;
