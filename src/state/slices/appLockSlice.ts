import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import type { RootState } from '../store';

type AppLockState = {
  autoLockMinutes: number; // 0 = never, 1, 5, 15, 30
  hasPassphraseSet: boolean; // true once EcKeyManager.setup() completes
  isLocked: boolean; // runtime signal — set by inactivity timer; DesktopSecurityGate also guards startup
};

const initialState: AppLockState = {
  autoLockMinutes: 5,
  hasPassphraseSet: false,
  isLocked: false,
};

const appLockSlice = createSlice({
  name: 'appLock',
  initialState,
  reducers: {
    setAutoLockMinutes: (state, action: PayloadAction<number>) => {
      state.autoLockMinutes = action.payload;
      console.log(`[AppLock] Auto-lock set to ${action.payload === 0 ? 'never' : `${action.payload} min`}`);
    },
    setPassphraseConfigured: (state, action: PayloadAction<boolean>) => {
      state.hasPassphraseSet = action.payload;
      console.log(`[AppLock] Passphrase ${action.payload ? 'configured' : 'cleared'}`);
    },
    lockApp: (state) => {
      state.isLocked = true;
      console.log('[AppLock] App locked');
    },
    unlockApp: (state) => {
      state.isLocked = false;
      console.log('[AppLock] App unlocked');
    },
  },
});

export const {
  setAutoLockMinutes,
  setPassphraseConfigured,
  lockApp,
  unlockApp,
} = appLockSlice.actions;

export const selectAppLock = (state: RootState) => state.appLock;
export const selectIsLocked = (state: RootState) => state.appLock.isLocked;
export const selectAutoLockMinutes = (state: RootState) => state.appLock.autoLockMinutes;
export const selectHasPassphraseSet = (state: RootState) => state.appLock.hasPassphraseSet;

export default appLockSlice.reducer;
