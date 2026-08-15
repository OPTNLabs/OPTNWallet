import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import { Network } from './networkSlice';
import type { RootState } from '../store';
import { WalletType } from '../../types/wallet';
import type { DerivationPathSource, ExtendedWalletType } from '../../types/wallet';

export interface WalletState {
  currentWalletId: number;
  sessionGeneration: number;
  networkType: Network;
  walletType: ExtendedWalletType;
  derivationPath: string;
  derivationPathSource: DerivationPathSource;
}

const initialState: WalletState = {
  currentWalletId: 0,
  sessionGeneration: 0,
  networkType: Network.CHIPNET,
  walletType: WalletType.STANDARD,
  derivationPath: '',
  derivationPathSource: 'default',
};

const walletSlice = createSlice({
  name: 'wallet_id',
  initialState,
  reducers: {
    setWalletId: (state, action: PayloadAction<number>) => {
      if (state.currentWalletId !== action.payload) {
        state.derivationPath = '';
        state.derivationPathSource = 'default';
      }
      state.currentWalletId = action.payload;
      state.sessionGeneration = (state.sessionGeneration ?? 0) + 1;
    },
    resetWallet: (state) => {
      const nextSessionGeneration = (state.sessionGeneration ?? 0) + 1;
      Object.assign(state, initialState);
      state.sessionGeneration = nextSessionGeneration;
    },
    setWalletNetwork: (state, action: PayloadAction<Network>) => {
      state.networkType = action.payload;
    },
    setWalletType: (state, action: PayloadAction<ExtendedWalletType>) => {
      state.walletType = action.payload;
    },
    setWalletDerivationPath: (
      state,
      action: PayloadAction<{ path: string; source: DerivationPathSource }>
    ) => {
      state.derivationPath = action.payload.path;
      state.derivationPathSource = action.payload.source;
    },
  },
});

export const {
  setWalletId,
  resetWallet,
  setWalletNetwork,
  setWalletType,
  setWalletDerivationPath,
} =
  walletSlice.actions;

export default walletSlice.reducer;

export const selectWalletId = (state: RootState) => state.wallet_id.currentWalletId;
export const selectHasWallet = (state: RootState) =>
  state.wallet_id.currentWalletId > 0;
export const selectNetworkType = (state: RootState) => state.wallet_id.networkType;
export const selectWalletType = (state: RootState) => state.wallet_id.walletType;
export const selectWalletDerivationPath = (state: RootState) =>
  state.wallet_id.derivationPath;
export const selectWalletDerivationPathSource = (state: RootState) =>
  state.wallet_id.derivationPathSource;
