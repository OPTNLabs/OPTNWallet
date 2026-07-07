import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import type { RootState } from '../store';

export type HardwareWalletType = 'none' | 'trezor' | 'ledger' | 'onekey' | 'keystone';

export type LedgerTransport = 'usb' | 'ble';

interface HardwareWalletState {
  type: HardwareWalletType;
  connected: boolean;
  xpub: string | null;
  deviceLabel: string | null;
  derivationPath: string;
  /** Ledger only: 'usb' (WebHID) or 'ble' (Bluetooth, for Nano X) */
  ledgerTransport: LedgerTransport;
}

const DEFAULT_DERIVATION_PATH = "m/44'/145'/0'";

const initialState: HardwareWalletState = {
  type: 'none',
  connected: false,
  xpub: null,
  deviceLabel: null,
  derivationPath: DEFAULT_DERIVATION_PATH,
  ledgerTransport: 'usb',
};

const hardwareWalletSlice = createSlice({
  name: 'hardwareWallet',
  initialState,
  reducers: {
    setHardwareWalletType(state, action: PayloadAction<HardwareWalletType>) {
      state.type = action.payload;
      if (action.payload === 'none') {
        state.connected = false;
        state.xpub = null;
        state.deviceLabel = null;
      }
    },
    setHardwareWalletConnected(
      state,
      action: PayloadAction<{ connected: boolean; xpub?: string; label?: string }>
    ) {
      state.connected = action.payload.connected;
      if (action.payload.xpub !== undefined) state.xpub = action.payload.xpub;
      if (action.payload.label !== undefined) state.deviceLabel = action.payload.label;
    },
    setDerivationPath(state, action: PayloadAction<string>) {
      state.derivationPath = action.payload;
    },
    setLedgerTransport(state, action: PayloadAction<LedgerTransport>) {
      state.ledgerTransport = action.payload;
    },
    disconnectHardwareWallet(state) {
      state.connected = false;
      state.xpub = null;
      state.deviceLabel = null;
    },
  },
});

export const {
  setHardwareWalletType,
  setHardwareWalletConnected,
  setDerivationPath,
  setLedgerTransport,
  disconnectHardwareWallet,
} = hardwareWalletSlice.actions;

export const selectHardwareWallet = (state: RootState) => state.hardwareWallet;
export const selectHardwareWalletType = (state: RootState) => state.hardwareWallet.type;
export const selectHardwareWalletConnected = (state: RootState) => state.hardwareWallet.connected;
export const selectHardwareWalletXpub = (state: RootState) => state.hardwareWallet.xpub;
export const selectLedgerTransport = (state: RootState) => state.hardwareWallet.ledgerTransport;

export default hardwareWalletSlice.reducer;
