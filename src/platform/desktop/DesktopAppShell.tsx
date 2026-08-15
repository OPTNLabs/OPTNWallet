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
import { useAutoFusion } from './useAutoFusion';
import { useWalletFusionPolicy } from './useWalletFusionPolicy';
import { useTransportConfig } from './useTransportConfig';
import { useWindowTitle } from './useWindowTitle';
import { migrateWalletFileNames } from './walletFile';
import { selectWalletId, resetWallet } from '../../state/slices/walletSlice';
import {
  hasCachedCredentialsForWallet,
  hasWatchOnlySession,
} from './WalletKeyCache';
import { persistor } from '../../state/store';
import { invoke } from '@tauri-apps/api/core';
import { pruneDesktopCache } from './filesystem';

const DesktopAppShell: React.FC = () => {
  useMenuBar();
  // Upgrade cleanup: old desktop builds stored unbounded base64 token icons in
  // localStorage. Trim only that disposable cache before Auto Fusion registers
  // its first effect, leaving quota for durable cross-window safety records.
  useEffect(() => {
    const removed = pruneDesktopCache();
    if (removed > 0) {
      console.info(
        `[desktop-cache] pruned ${removed} oversized cache entr${removed === 1 ? 'y' : 'ies'}`
      );
    }
  }, []);
  // App-wide, so automatic rounds do not require the CashFusion screen to be
  // open. It gates itself on wallet/session state and refuses unless the durable
  // cooldown and the cross-window lease both allow a round.
  // Fusion policy belongs to the wallet, not the window: loaded when a wallet
  // opens and written back on change, so it survives window close and restart.
  // Must run BEFORE the engine reads those values.
  // Transport config describes how the PROCESS reaches the network, so it is
  // shared by every window rather than per wallet or per window.
  useTransportConfig();
  const fusionPolicyReady = useWalletFusionPolicy();
  useAutoFusion(fusionPolicyReady);
  // Which wallet this window holds, in the title bar — with several windows
  // open it is the only way to tell them apart without focusing each one.
  useWindowTitle();

  // One-time tidy of backups still named `wallet-<id>-<name>.optn`. Renaming on
  // write alone would never reach a wallet nobody reconfigures.
  useEffect(() => {
    // Once per install, never again, and never on the path the user is waiting
    // on. Renaming is O(n^2) in file reads — each rewrite re-lists the folder
    // and reads every other file to check ownership — so with a folder of
    // wallets it is hundreds of IPC round-trips. Running that at shell mount
    // made unlocking feel slow, which is a regression, not the cost of the KDF.
    const DONE_KEY = 'optn-wallet-file-names-migrated';
    try {
      if (window.localStorage.getItem(DONE_KEY) === '1') return;
    } catch {
      // Storage unavailable: skip rather than risk running this every launch.
      return;
    }

    // Deferred off the critical path: the wallet list and unlock do not depend
    // on backup filenames, so this can happen after the window is interactive.
    const idle =
      (
        window as unknown as {
          requestIdleCallback?: (cb: () => void) => number;
        }
      ).requestIdleCallback ??
      ((cb: () => void) => window.setTimeout(cb, 3000));

    idle(() => {
      void migrateWalletFileNames()
        .then((renamed) => {
          try {
            window.localStorage.setItem(DONE_KEY, '1');
          } catch {
            /* best effort */
          }
          if (renamed > 0) {
            console.info(
              `[walletFile] renamed ${renamed} legacy wallet backup(s)`
            );
          }
        })
        .catch(() => undefined);
    });
  }, []);
  const dispatch = useDispatch();
  const walletId = useSelector(selectWalletId);

  // Fused labels are durable SQL (not memory). Hydrate on wallet open + merge
  // recovery from AppData fusion-txid-recovery.json (built from fuse logs).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { hydrateFusionLabels, restoreFusionLabelsFromRecoveryFile } =
          await import('./fusionCoinDepth');
        const r = await restoreFusionLabelsFromRecoveryFile();
        if (!cancelled && r.wallets > 0) {
          console.info(
            `[fusion] restored Fused labels for ${r.wallets} wallet(s) (+${r.txids} new txids)`
          );
        }
        if (cancelled) return;
        if (Number.isInteger(walletId) && walletId > 0) {
          await hydrateFusionLabels(walletId);
        }
      } catch {
        /* labels best-effort */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [walletId]);

  const [rehydrated, setRehydrated] = useState(
    () => persistor.getState().bootstrapped
  );
  const [invariantChecked, setInvariantChecked] = useState(false);
  // After the ciphertext-model migration, credentials are password+salt in RAM
  // — not a cached CryptoKey. The old getCachedWalletKeyForWallet() always
  // returned null, which made this shell treat every successful unlock as
  // "stale session" and wipe the wallet (blank screen / bounce to picker).
  // A watch-only wallet has no credentials by design; its open session is the
  // explicit watch-only marker in WalletKeyCache.
  const hasValidWalletSession =
    walletId <= 0 ||
    hasCachedCredentialsForWallet(walletId) ||
    hasWatchOnlySession(walletId);

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

  // Core invariant: a wallet is "open" ONLY while its credentials are in RAM.
  // The password/salt cache is per-window and empty on every boot, so a
  // walletId > 0 with no credentials is stale — from persisted rehydration
  // (normal restart) or another window opening a wallet (shared IndexedDB).
  // Only runs once rehydration has finished. Safe against real opens:
  // openWalletWithPassword caches password+salt BEFORE setWalletId, so by the
  // time walletId > 0 the credentials are present.
  useEffect(() => {
    if (!rehydrated) return;
    if (
      walletId > 0 &&
      !hasCachedCredentialsForWallet(walletId) &&
      !hasWatchOnlySession(walletId)
    ) {
      dispatch(resetWallet());
    }
    setInvariantChecked(true);
  }, [rehydrated, walletId, dispatch]);

  // A Tauri webview silently blocks target="_blank" links, so faucet/explorer/
  // external links never open. Intercept clicks on external http(s) links and
  // open them in the user's default browser via the open_external command.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const anchor = (e.target as HTMLElement | null)?.closest?.('a');
      const href = anchor?.getAttribute('href');
      if (href && /^https?:\/\//i.test(href)) {
        e.preventDefault();
        void invoke('open_external', { url: href }).catch(() => {});
      }
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);

  // Don't mount AppShell (and everything under it — including
  // useAppLifecycle.ts's walletId>0-triggered hooks: WizardConnect init,
  // getWalletInfo, etc.) until BOTH rehydration has finished AND the
  // invariant above has had a chance to correct a stale walletId. React
  // fires child effects before parent effects, so if children mounted any
  // earlier, they'd read a still-rehydrating or still-stale walletId and
  // fail before this invariant could correct it — the source of the "Error
  // getting wallet info" / "Unable to load wallet mnemonic for WizardConnect"
  // noise seen on every fresh app start.
  if (!rehydrated || !invariantChecked || !hasValidWalletSession) {
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
