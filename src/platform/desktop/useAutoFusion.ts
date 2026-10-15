// Keeps Auto Fusion running after an explicit user-started round.
//
// Mounted in DesktopAppShell so continuation does not depend on the CashFusion
// screen staying open. The in-memory session gate is intentionally separate from
// the persisted preference: opening/restoring a wallet must never start a round.
//
// Auto itself is one run of the shared Rust driver -- the loop the CLI and the
// docker lab run -- which keeps the cooldowns, the depth target and the P2P
// rendezvous window. This hook only starts that run when Auto should be on,
// stops it when it should not, restarts it when its settings change between
// rounds, and makes sure integrated Tor is up first.

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useSelector } from 'react-redux';

import {
  selectAutoFuseEnabled,
  selectCashFusionEnabled,
  selectFuseDepth,
  selectFusionServer,
  selectFusionServers,
  selectP2pFusionEnabled,
  selectTorAuto,
  selectTorEnabled,
  selectTorHost,
  selectTorPortManual,
} from '../../state/slices/experimentalSlice';
import type { RootState } from '../../state/store';
import { logError } from '../../utils/errorHandling';
import { resolveFusionTransport } from './FusionTorResolver';
import { AUTO_FUSION_RETRY_MS, type FusionMode } from './fusionAutoEngine';
import {
  autoFusionRun,
  cancelFusionRound,
  getFusionActivity,
  isNativeFusionBusy,
  setFusionLastResult,
  startAutoFusion,
  stopFusionRun,
  subscribeFusionActivity,
  subscribeFusionRun,
} from './FusionRunnerService';
import type { NativeFusionVenue } from './nativeFusion';
import {
  disarmAutoFusionSession,
  isAutoFusionSessionArmed,
  subscribeAutoFusionSession,
} from './fusionAutoSession';

/** The host a server venue is reached at, for starting Tor before Rust checks it. */
function serverHost(server: string): string {
  const trimmed = server.trim();
  if (trimmed.startsWith('[')) return trimmed.slice(1, trimmed.indexOf(']'));
  return trimmed.split(':')[0] ?? '';
}

export function useAutoFusion(policyReady = true): void {
  const cashFusionEnabled = useSelector(selectCashFusionEnabled);
  const autoFuseEnabled = useSelector(selectAutoFuseEnabled);
  const p2pFusionEnabled = useSelector(selectP2pFusionEnabled);
  const savedFusionServer = useSelector(selectFusionServer);
  const fusionServers = useSelector(selectFusionServers);
  const fuseDepth = useSelector(selectFuseDepth);
  const torEnabled = useSelector(selectTorEnabled);
  const torAuto = useSelector(selectTorAuto);
  const torHost = useSelector(selectTorHost);
  const torPortManual = useSelector(selectTorPortManual);
  const walletId = useSelector(
    (state: RootState) => state.wallet_id.currentWalletId
  );
  const network = useSelector(
    (state: RootState) => state.network.currentNetwork
  );
  const armed = useSyncExternalStore(
    subscribeAutoFusionSession,
    () => isAutoFusionSessionArmed(walletId),
    () => false
  );
  // '' no run; 'busy' a manual run or another wallet's; else this wallet's
  // Auto run, named by the settings it started with.
  const running = useSyncExternalStore(
    subscribeFusionRun,
    () => autoFusionRun(walletId)?.key ?? (isNativeFusionBusy() ? 'busy' : ''),
    () => ''
  );
  const roundInProgress = useSyncExternalStore(
    (onChange) => subscribeFusionActivity(walletId, () => onChange()),
    () => getFusionActivity(walletId) !== null,
    () => false
  );
  const [retryTick, setRetryTick] = useState(0);

  // A real wallet-session boundary stops the run: another wallet or network,
  // or CashFusion or its transport switched. Routes changing do nothing.
  useEffect(
    () => () => {
      if (walletId > 0) {
        cancelFusionRound(walletId, 'wallet fusion session changed');
        disarmAutoFusionSession(walletId);
      }
    },
    [walletId, network, cashFusionEnabled, p2pFusionEnabled]
  );

  const mode: FusionMode = p2pFusionEnabled ? 'p2p' : 'server';
  // Keyed on content: the server list is re-serialized on health refreshes,
  // and a new array alone must not restart a run.
  const serversKey = JSON.stringify(fusionServers);
  const venue = useMemo<NativeFusionVenue | null>(() => {
    if (mode === 'p2p') return { mode: 'p2p' };
    const configured = JSON.parse(serversKey) as string[];
    const selected =
      savedFusionServer && configured.includes(savedFusionServer)
        ? savedFusionServer
        : configured[0];
    return selected ? { mode: 'server', selected, configured } : null;
  }, [mode, savedFusionServer, serversKey]);
  const key = JSON.stringify([venue, fuseDepth]);
  const shouldRun =
    policyReady &&
    cashFusionEnabled &&
    autoFuseEnabled &&
    armed &&
    walletId > 0;

  useEffect(() => {
    if (!shouldRun) {
      if (running && running !== 'busy') void stopFusionRun(walletId);
      return;
    }
    if (running === 'busy') return;
    if (running) {
      // Settings changed: restart between rounds, never inside one -- a
      // round waits minutes in the pool, and cancelling it wastes everyone's.
      if (running !== key && !roundInProgress) void stopFusionRun(walletId);
      return;
    }

    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const retryLater = () => {
      if (cancelled) return;
      retry = setTimeout(
        () => setRetryTick((n) => n + 1),
        AUTO_FUSION_RETRY_MS
      );
    };
    const fail = (message: string) => {
      setFusionLastResult(walletId, {
        mode,
        trigger: 'auto',
        ok: false,
        message: `Auto-fuse (${mode}): ${message} — retrying…`,
      });
      retryLater();
    };
    void (async () => {
      if (!venue) {
        fail('no fusion server selected');
        return;
      }
      try {
        // Integrated Tor may not be running yet. Rust verifies the proxy
        // itself; this only starts it, and fails early when none can serve.
        const route = await resolveFusionTransport(
          venue.mode === 'p2p'
            ? 'nostr-relay'
            : serverHost(venue.selected ?? ''),
          {
            enabled: torEnabled,
            auto: torAuto,
            host: torHost,
            manualPort: torPortManual,
            autoStartIntegrated: true,
          }
        );
        if (cancelled) return;
        if (route.type === 'unavailable') {
          fail(route.reason);
          return;
        }
        const started = await startAutoFusion({
          walletId,
          mode,
          venue,
          fuseDepth,
          key,
        });
        if (started === 'pending') retryLater();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logError('AutoFusion.start', error, { walletId, mode });
        fail(message);
      }
    })();
    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
    };
  }, [
    shouldRun,
    running,
    roundInProgress,
    key,
    venue,
    mode,
    fuseDepth,
    walletId,
    torEnabled,
    torAuto,
    torHost,
    torPortManual,
    retryTick,
  ]);
}
