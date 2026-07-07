// Desktop wrapper around the real app. Swapped in via vite.desktop.config.ts's
// desktopModuleSwapPlugin (replaces src/app/AppShell.tsx for desktop builds
// only) so the upstream AppShell.tsx stays byte-identical and untouched.
//
// Electron Cash security model: there is NO app-level password. The landing
// wallet picker is the public start screen; each wallet's OWN password is
// asked when opening that wallet (DesktopWalletManager). "Lock" — manual via
// the menu or by inactivity (AppLockGate) — wipes the in-RAM key and returns
// to the picker.
import React, { useEffect } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import AppShell from '../../app/AppShell';
import { AppLockGate } from './AppLockGate';
import { useMenuBar } from './useMenuBar';
import { selectWalletId, resetWallet } from '../../state/slices/walletSlice';
import { getCachedWalletKey } from './WalletKeyCache';

const DesktopAppShell: React.FC = () => {
  useMenuBar();
  const dispatch = useDispatch();
  const walletId = useSelector(selectWalletId);

  // Core invariant: a wallet is "open" ONLY while its key is in RAM. The key
  // cache is per-window and empty on every boot, so a walletId > 0 with no
  // cached key is stale — it comes from persisted state rehydrating (normal
  // restart) or from another window opening a wallet (windows share the same
  // IndexedDB origin). Clearing it here makes every fresh window/boot land on
  // the picker instead of auto-resuming a wallet whose key we don't have.
  // Safe against real opens: openWalletWithPassword caches the key BEFORE
  // dispatching setWalletId, so by the time walletId > 0 the key is present.
  useEffect(() => {
    if (walletId > 0 && !getCachedWalletKey()) {
      dispatch(resetWallet());
    }
  }, [walletId, dispatch]);

  return (
    <>
      <AppShell />
      <AppLockGate />
    </>
  );
};

export default DesktopAppShell;
