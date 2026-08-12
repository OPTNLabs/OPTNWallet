import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import { Network } from './networkSlice';

export type WalletOperationKind =
  | 'network-switch'
  | 'derivation-change'
  | 'reload';
export type WalletOperationStage =
  | 'preparing'
  | 'clearing'
  | 'deriving'
  | 'syncing';

export type WalletReconfigurationState = {
  status: 'idle' | 'running' | 'error';
  kind: WalletOperationKind | null;
  stage: WalletOperationStage | null;
  targetNetwork: Network | null;
  error: string | null;
};

const initialState: WalletReconfigurationState = {
  status: 'idle',
  kind: null,
  stage: null,
  targetNetwork: null,
  error: null,
};

const walletReconfigurationSlice = createSlice({
  name: 'walletReconfiguration',
  initialState,
  reducers: {
    beginWalletReconfiguration: (
      state,
      action: PayloadAction<{
        kind: WalletOperationKind;
        targetNetwork?: Network;
      }>
    ) => {
      state.status = 'running';
      state.kind = action.payload.kind;
      state.stage = 'preparing';
      state.targetNetwork = action.payload.targetNetwork ?? null;
      state.error = null;
    },
    setWalletReconfigurationStage: (
      state,
      action: PayloadAction<WalletOperationStage>
    ) => {
      if (state.status === 'running') state.stage = action.payload;
    },
    completeWalletReconfiguration: (state) => {
      Object.assign(state, initialState);
    },
    failWalletReconfiguration: (state, action: PayloadAction<string>) => {
      state.status = 'error';
      state.stage = null;
      state.error = action.payload;
    },
    dismissWalletReconfiguration: (state) => {
      Object.assign(state, initialState);
    },
  },
});

export const {
  beginWalletReconfiguration,
  setWalletReconfigurationStage,
  completeWalletReconfiguration,
  failWalletReconfiguration,
  dismissWalletReconfiguration,
} = walletReconfigurationSlice.actions;

export default walletReconfigurationSlice.reducer;
