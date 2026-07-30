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
  selectNostrRelays,
  selectP2pFusionEnabled,
  selectTorAuto,
  selectTorEnabled,
  selectTorHost,
  selectTorPortManual,
} from '../../state/slices/experimentalSlice';
import type { RootState } from '../../state/store';
import { subscribeWalletUtxoRefresh } from '../../services/WalletUtxoRefreshService';
import { logError } from '../../utils/errorHandling';
import { resolveFusionTransport } from './FusionTorResolver';
import { decideAutoFusion } from './fusionAutoEngine';
import { startFusionRound } from './FusionRunnerService';
import { runP2pFusion } from './FusionP2pService';

/**
 * How often the engine re-asks whether it may run.
 *
 * This is only a poll; the real spacing between paid attempts is the durable
 * cooldown inside the runner. Waking often is cheap because a refused decision
 * costs nothing, while waking rarely would leave a freshly received coin
 * unfused for no reason.
 */
const ENGINE_TICK_MS = 60_000;

export function useAutoFusion(): void {
  const cashFusionEnabled = useSelector(selectCashFusionEnabled);
  const autoFuseEnabled = useSelector(selectAutoFuseEnabled);
  const p2pFusionEnabled = useSelector(selectP2pFusionEnabled);
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
  useEffect(() => {
    sessionRef.current += 1;
    activeControllerRef.current?.abort();
    activeControllerRef.current = null;
  }, [
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
  ]);

  const tick = useCallback(async () => {
    if (activeControllerRef.current) return;
    const controller = new AbortController();
    activeControllerRef.current = controller;
    try {
      const session = sessionRef.current;

      // Resolve the route live: integrated Tor can start after mount, and users
      // may instead run Tor Browser/daemon or select a verified manual proxy.
      let torReady = false;
      let p2pTor: { host: string; port: number } | null = null;
      if (p2pFusionEnabled) {
        try {
          const route = await resolveFusionTransport('nostr-relay', {
            enabled: torEnabled,
            auto: torAuto,
            host: torHost,
            manualPort: torPortManual,
          });
          if (route.type === 'tor') {
            torReady = true;
            p2pTor = route.tor;
          }
        } catch {
          torReady = false;
        }
      } else {
        // Server auto-fusion remains fail-closed until the shared server runner
        // is implemented; keep its future Tor requirement explicit.
        torReady = torEnabled;
      }

      const decision = decideAutoFusion({
        cashFusionEnabled,
        autoFuseEnabled,
        p2pFusionEnabled,
        walletId,
        torReady,
      });
      if (!decision.run || controller.signal.aborted) return;
      // The shared server runner is the next checkpoint. Do not enter the
      // authoritative runner (and therefore do not consume its fee cooldown)
      // until that transport can actually execute.
      if (decision.mode === 'server') return;

      // The wallet may have been switched or locked while Tor was queried.
      if (session !== sessionRef.current) return;

      const outcome = await startFusionRound({
        walletId,
        network,
        mode: decision.mode,
        trigger: 'auto',
        fuseDepth,
        signal: controller.signal,
        runners: {
          runP2p: async (coins, signal) => {
            if (!p2pTor) {
              throw new Error(
                'No verified Tor route is available for P2P Fusion.'
              );
            }
            return runP2pFusion({
              walletId,
              network,
              utxos: coins,
              relays: nostrRelays,
              tor: p2pTor,
              signal,
            });
          },
          // Server fusion needs a handshake, tier choice and output allocation
          // that only the settings screen currently assembles. Until that is
          // extracted, an automatic SERVER round is refused rather than run with
          // guessed parameters — refusing costs a missed round, guessing spends a
          // fee on a round that cannot complete.
          runServer: () =>
            Promise.reject(
              new Error('Automatic server fusion is not wired up yet.')
            ),
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
    walletId,
    network,
  ]);

  useEffect(() => {
    if (!cashFusionEnabled || !autoFuseEnabled || walletId <= 0) return;
    let disposed = false;

    const run = () => {
      if (disposed) return;
      void tick().catch((error) => {
        logError('AutoFusion.tick', error, { walletId });
      });
    };

    // No blind mount-time run. The first event-driven attempt waits until the
    // wallet has committed a fresh UTXO snapshot; the interval is only a
    // backstop for missed send/receive notifications.
    const unsubscribeRefresh = subscribeWalletUtxoRefresh(
      (refreshedWalletId) => {
        if (refreshedWalletId === walletId) run();
      }
    );
    const timer = setInterval(run, ENGINE_TICK_MS);
    return () => {
      disposed = true;
      unsubscribeRefresh();
      clearInterval(timer);
      activeControllerRef.current?.abort();
      activeControllerRef.current = null;
    };
  }, [cashFusionEnabled, autoFuseEnabled, walletId, tick]);
}
