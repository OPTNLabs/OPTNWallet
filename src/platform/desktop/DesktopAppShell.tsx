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
import { persistor } from '../../state/store';

const DesktopAppShell: React.FC = () => {
  useMenuBar();
  const dispatch = useDispatch();
  const walletId = useSelector(selectWalletId);
  const [rehydrated, setRehydrated] = useState(() => persistor.getState().bootstrapped);
  const [invariantChecked, setInvariantChecked] = useState(false);

  // redux-persist rehydrates asynchronously; wait for it before reading the
  // persisted walletId (below). The immediate re-check after subscribing closes
  // a race where bootstrap completes between the initial read and the
  // subscribe — under StrictMode's dev-only mount/unmount/remount that gap can
  // otherwise be missed, leaving the app permanently blank. The timeout is a
  // hard floor so the main render path can never hang on persistence.
  useEffect(() => {
    if (rehydrated) return;
    const markReady = () => setRehydrated(true);
    const unsubscribe = persistor.subscribe(() => {
      if (persistor.getState().bootstrapped) markReady();
    });
    if (persistor.getState().bootstrapped) markReady();
    const fallback = setTimeout(markReady, 3000);
    return () => {
      unsubscribe();
      clearTimeout(fallback);
    };
  }, [rehydrated]);

  // Core invariant: a wallet is "open" ONLY while its key is in RAM. The key
  // cache is per-window and empty on every boot, so a walletId > 0 with no
  // cached key is stale — it comes from persisted state rehydrating (normal
  // restart) or from another window opening a wallet (windows share the same
  // IndexedDB origin). Only runs once rehydration has actually finished, so
  // walletId here is the real final persisted value, not a transient default.
  // Safe against real opens: openWalletWithPassword caches the key BEFORE
  // dispatching setWalletId, so by the time walletId > 0 the key is present.
  useEffect(() => {
    if (!rehydrated) return;
    if (walletId > 0 && !getCachedWalletKey()) {
      dispatch(resetWallet());
    }
    setInvariantChecked(true);
  }, [rehydrated, walletId, dispatch]);

  // Don't mount AppShell (and everything under it — including
  // useAppLifecycle.ts's walletId>0-triggered hooks: WizardConnect init,
  // getWalletInfo, etc.) until BOTH rehydration has finished AND the
  // invariant above has had a chance to correct a stale walletId. React
  // fires child effects before parent effects, so if children mounted any
  // earlier, they'd read a still-rehydrating or still-stale walletId and
  // fail before this invariant could correct it — the source of the "Error
  // getting wallet info" / "Unable to load wallet mnemonic for WizardConnect"
  // noise seen on every fresh app start.
  if (!rehydrated || !invariantChecked) {
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
