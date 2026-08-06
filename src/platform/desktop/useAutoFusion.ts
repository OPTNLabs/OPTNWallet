// Drives automatic fusion rounds, app-wide.
//
// Mounted in DesktopAppShell rather than in the CashFusion screen: a timer
// living in that component would only fuse while the user happened to be looking
// at it, which is not what "fuse automatically" can mean.
//
// It decides nothing about coins, cooldowns or concurrency. Those belong to
// FusionRunnerService, which is also what the manual buttons call, so automatic
// and manual rounds cannot diverge. This hook is a clock and a wallet-session
// guard.

import { useCallback, useEffect, useRef } from 'react';
import { useSelector } from 'react-redux';

import {
  selectAutoFuseEnabled,
  selectCashFusionEnabled,
  selectFuseDepth,
  selectFusionServer,
  selectFusionServers,
  selectNostrRelays,
  selectP2pFusionEnabled,
  selectTorAuto,
  selectTorEnabled,
  selectTorHost,
  selectTorPortManual,
} from '../../state/slices/experimentalSlice';
import type { RootState } from '../../state/store';
import {
  subscribeWalletUtxoRefresh,
  type WalletUtxoSnapshot,
} from '../../services/WalletUtxoRefreshService';
import { logError } from '../../utils/errorHandling';
import { resolveFusionTransport } from './FusionTorResolver';
import {
  AUTO_FUSION_COOLDOWN_MS,
  decideAutoFusion,
} from './fusionAutoEngine';
import { isAutoCooldownReady } from './fusionWalletLease';
import {
  reportFusionProgress,
  startFusionRound,
} from './FusionRunnerService';
import { runP2pFusion } from './FusionP2pService';
import {
  buildServerRunner,
  defaultInputLookupEndpoint,
  parseFusionServerTarget,
  serverFusionPrivacyDestination,
} from './ServerFusionRunner';

/**
 * How often the engine re-asks whether it may run.
 *
 * This is only a recovery poll; committed UTXO refreshes wake the engine
 * immediately. Keep the blind fallback aligned with the durable cooldown so an
 * idle or empty wallet does not perform a full Electrum reconciliation every
 * minute in every open window.
 */
// Electron Cash spaces automatic fusions by a RANDOM interval, not a fixed one
// (plugin.py: AUTOFUSE_RECENT_TOR_LIMIT_LOWER = 60, ..._UPPER = 120). A fixed
// period is a timing fingerprint: a passive observer watching relay or Tor
// traffic sees rounds begin on a predictable cadence and can group them, which
// is the correlation fusing exists to break. Matching their bounds.
const ENGINE_TICK_MIN_MS = 60_000;
const ENGINE_TICK_MAX_MS = 120_000;

/** A fresh interval for each tick, so the cadence never settles into a pattern. */
function nextEngineTickMs(): number {
  return (
    ENGINE_TICK_MIN_MS +
    Math.floor(Math.random() * (ENGINE_TICK_MAX_MS - ENGINE_TICK_MIN_MS + 1))
  );
}

export function useAutoFusion(): void {
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
  const nostrRelays = useSelector(selectNostrRelays);
  const walletId = useSelector(
    (state: RootState) => state.wallet_id.currentWalletId
  );
  const network = useSelector(
    (state: RootState) => state.network.currentNetwork
  );

  /** Bumped whenever the wallet session changes, to strand stale completions. */
  const sessionRef = useRef(0);
  const activeControllerRef = useRef<AbortController | null>(null);
  // What these settings ARE, not which objects they happen to be. `nostrRelays`
  // and `fusionServers` are arrays rebuilt on most renders, so keying the abort
  // below on identity cancelled live rounds whenever anything re-rendered —
  // while the settings themselves had not changed at all.
  const sessionKey = JSON.stringify([
    walletId,
    network,
    cashFusionEnabled,
    autoFuseEnabled,
    p2pFusionEnabled,
    torEnabled,
    torAuto,
    torHost,
    torPortManual,
    nostrRelays,
    savedFusionServer,
    fusionServers,
  ]);
  useEffect(() => {
    sessionRef.current += 1;
    activeControllerRef.current?.abort();
    activeControllerRef.current = null;
  }, [sessionKey]);

  const tick = useCallback(async (freshSnapshot?: WalletUtxoSnapshot) => {
    if (activeControllerRef.current) return;
    // The recovery poll must be almost free during the durable cooldown: do
    // not probe or start Tor until another automatic attempt is actually due.
    // startFusionRound repeats this advisory check and atomically claims later.
    if (!isAutoCooldownReady(walletId, AUTO_FUSION_COOLDOWN_MS)) return;
    const controller = new AbortController();
    activeControllerRef.current = controller;
    try {
      const session = sessionRef.current;

      // Resolve the route live: integrated Tor can start after mount, and users
      // may instead run Tor Browser/daemon or select a verified manual proxy.
      let torReady = false;
      let p2pTor: { host: string; port: number } | null = null;
      let serverRunner: ReturnType<typeof buildServerRunner> | null = null;
      if (p2pFusionEnabled) {
        try {
          const route = await resolveFusionTransport('nostr-relay', {
            enabled: torEnabled,
            auto: torAuto,
            host: torHost,
            manualPort: torPortManual,
            autoStartIntegrated: true,
          });
          if (route.type === 'tor') {
            torReady = true;
            p2pTor = route.tor;
          }
        } catch {
          torReady = false;
        }
      } else {
        const selectedServer =
          savedFusionServer && fusionServers.includes(savedFusionServer)
            ? savedFusionServer
            : fusionServers[0];
        if (!selectedServer) return;
        try {
          const target = parseFusionServerTarget(selectedServer);
          const inputLookupEndpoint = defaultInputLookupEndpoint(network);
          const privacyDestination = serverFusionPrivacyDestination(
            target.host,
            inputLookupEndpoint.host
          );
          const route = await resolveFusionTransport(privacyDestination, {
            enabled: torEnabled,
            auto: torAuto,
            host: torHost,
            manualPort: torPortManual,
            autoStartIntegrated: true,
          });
          if (route.type === 'unavailable') return;
          torReady = true;
          serverRunner = buildServerRunner({
            walletId,
            network,
            ...target,
            tor: route.type === 'tor' ? route.tor : null,
            inputLookupEndpoint,
          });
        } catch {
          torReady = false;
        }
      }

      const decision = decideAutoFusion({
        cashFusionEnabled,
        autoFuseEnabled,
        p2pFusionEnabled,
        walletId,
        torReady,
      });
      if (!decision.run || controller.signal.aborted) return;

      // The wallet may have been switched or locked while Tor was queried.
      if (session !== sessionRef.current) return;

      const outcome = await startFusionRound({
        walletId,
        network,
        mode: decision.mode,
        trigger: 'auto',
        fuseDepth,
        freshSnapshot,
        signal: controller.signal,
        runners: {
          runP2p: async (coins, signal, progress) => {
            if (!p2pTor) {
              throw new Error(
                'No verified Tor route is available for P2P Fusion.'
              );
            }
            progress?.onStatus?.('Checking Tor…');
            return runP2pFusion({
              walletId,
              network,
              utxos: coins,
              relays: nostrRelays,
              tor: p2pTor,
              trigger: 'auto',
              signal,
              onStatus: (m) => {
                reportFusionProgress(walletId, { status: m });
                progress?.onStatus?.(m);
              },
              onPhase: (p) => {
                reportFusionProgress(walletId, { phase: p });
                progress?.onPhase?.(p);
              },
            });
          },
          runServer: async (coins, signal, progress) => {
            if (!serverRunner) {
              throw new Error(
                'No verified server Fusion route is available.'
              );
            }
            progress?.onStatus?.('Auto-fuse (server): contacting fusion server…');
            return serverRunner(coins, signal);
          },
        },
      });

      // A round that finished after the wallet changed must not report into the
      // new session.
      if (session !== sessionRef.current) return;

      if (outcome.status === 'failed') {
        logError('AutoFusion.round', new Error(outcome.message), {
          walletId,
          mode: outcome.mode,
        });
      } else if (outcome.status === 'fused' && outcome.warning) {
        logError('AutoFusion.completionWarning', new Error(outcome.warning), {
          walletId,
          mode: outcome.mode,
          txid: outcome.txid,
        });
      }
    } finally {
      if (activeControllerRef.current === controller) {
        activeControllerRef.current = null;
      }
    }
  }, [
    cashFusionEnabled,
    autoFuseEnabled,
    p2pFusionEnabled,
    fuseDepth,
    torEnabled,
    torAuto,
    torHost,
    torPortManual,
    nostrRelays,
    savedFusionServer,
    fusionServers,
    walletId,
    network,
  ]);

  useEffect(() => {
    if (!cashFusionEnabled || !autoFuseEnabled || walletId <= 0) return;
    let disposed = false;

    const run = (freshSnapshot?: WalletUtxoSnapshot) => {
      if (disposed) return;
      void tick(freshSnapshot).catch((error) => {
        logError('AutoFusion.tick', error, { walletId });
      });
    };

    // No blind mount-time run. The first event-driven attempt waits until the
    // wallet has committed a fresh UTXO snapshot; the interval is only a
    // backstop for missed send/receive notifications.
    const unsubscribeRefresh = subscribeWalletUtxoRefresh(
      (refreshedWalletId, snapshot) => {
        if (refreshedWalletId === walletId) run(snapshot);
      }
    );
    // setTimeout, re-armed each time, rather than setInterval: a fixed interval
    // cannot be re-randomised between ticks.
    let timer = setTimeout(function tick() {
      void run();
      timer = setTimeout(tick, nextEngineTickMs());
    }, nextEngineTickMs());
    // Stop SCHEDULING, but deliberately leave any in-flight round alone.
    //
    // This effect re-runs whenever `tick` changes identity, and `tick` depends
    // on `nostrRelays` and `fusionServers` — arrays that are new objects on most
    // renders. Aborting here therefore cancelled rounds for no reason at all: a
    // round waits up to 120s in the join pool, and any render in that window
    // killed it. Observed live — three wallets had just met in tier 3,900,000
    // and reached StartRound when a re-render cancelled the other two, and the
    // survivor died with "too few remaining live players".
    //
    // A round that genuinely must stop — the wallet closed, the network changed,
    // fusion was switched off — is aborted by the session effect above, which
    // keys on exactly those things.
    return () => {
      disposed = true;
      unsubscribeRefresh();
      clearTimeout(timer);
    };
  }, [cashFusionEnabled, autoFuseEnabled, walletId, tick]);
}
