// Desktop wrapper around the real app. Swapped in via vite.desktop.config.ts's
// desktopModuleSwapPlugin (replaces src/app/AppShell.tsx for desktop builds
// only) so the upstream AppShell.tsx stays byte-identical and untouched.
//
// Electron Cash security model: there is NO app-level password. The landing
// wallet picker is the public start screen; each wallet's OWN password is
// asked when opening that wallet (DesktopWalletManager). "Lock" — manual via
// the menu or by inactivity (AppLockGate) — wipes the in-RAM key and returns
// to the picker.
import React, { useEffect, useState } from 'react';
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
  const [checkedStaleWalletOnce, setCheckedStaleWalletOnce] = useState(false);

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
    setCheckedStaleWalletOnce(true);
  }, [walletId, dispatch]);

  // Don't mount AppShell (and everything under it — including
  // useAppLifecycle.ts's walletId>0-triggered hooks: WizardConnect init,
  // getWalletInfo, etc.) until the invariant above has been checked at least
  // once. React fires child effects before parent effects, so without this
  // gate, a fresh boot with a stale persisted walletId lets those child hooks
  // fire with the stale id and fail (harmless — nothing was ever actually
  // unlocked) before resetWallet() above has a chance to correct it. That's
  // the source of the "Error getting wallet info" / "Unable to load wallet
  // mnemonic for WizardConnect" noise seen on every fresh app start.
  if (!checkedStaleWalletOnce) {
    return null;
  }

  return (
    <>
      <AppShell />
      <AppLockGate />
    </>
  );
};

export default DesktopAppShell;
