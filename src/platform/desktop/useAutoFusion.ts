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
import { fetchFusionServerStatus } from '../../services/fusion/FusionStatusService';
import { resolveFusionTransport } from './FusionTorResolver';
import {
  AUTO_FUSION_COOLDOWN_MS,
  AUTO_FUSION_RETRY_MS,
  decideAutoFusion,
  msUntilAutoRendezvousOpen,
  msUntilServerAutoStart,
  nextAutoEngineTickForMode,
} from './fusionAutoEngine';
import { SERVER_AUTOFUSE_INACTIVE_MS } from './fusionTiming';
// Continuity: after each round ends, re-arm like EC's plugin loop.
import { coinsBelowDepth } from './fusionCoinDepth';
import {
  clearAutoCooldown,
  isAutoCooldownReady,
  isAutoDepthMetIdle,
  stampAutoFailure,
  wakeAutoFromWalletActivity,
} from './fusionWalletLease';
import {
  cancelFusionRound,
  reportFusionProgress,
  setFusionLastResult,
  startFusionRound,
} from './FusionRunnerService';
import { runP2pFusion } from './FusionP2pService';
import {
  buildServerRunner,
  defaultInputLookupEndpoint,
  parseFusionServerTarget,
  serverFusionPrivacyDestination,
  validateServerHello,
} from './ServerFusionRunner';
import { selectPreparedFusionServer } from './serverFusionFailover';

function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('fusion round cancelled'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('fusion round cancelled'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
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
  const nostrRelays = useSelector(selectNostrRelays);
  const walletId = useSelector(
    (state: RootState) => state.wallet_id.currentWalletId
  );
  const network = useSelector(
    (state: RootState) => state.network.currentNetwork
  );

  /** Bumped whenever the wallet session changes, to strand stale completions. */
  const sessionRef = useRef(0);
  const previousWalletIdRef = useRef(walletId);
  const sessionInitializedRef = useRef(false);
  const activeControllerRef = useRef<AbortController | null>(null);
  /** Always call the latest tick from deferred re-queue (EC unattended loop). */
  const tickRef = useRef<(fresh?: WalletUtxoSnapshot) => Promise<void>>(
    async () => undefined
  );
  const followUpTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Abort ONLY when the wallet/network or selected Fusion transport changes.
  // Auto, Tor, relay and server preference edits apply to the next round; they
  // must not cancel a manual or already-started automatic financial action.
  // Do NOT include `nostrRelays` / `fusionServers`:
  // auto health refresh and HMR re-serialize those arrays and used to cancel
  // live gathers mid-pool (observed: strict=1 then "fusion round cancelled"
  // ~6s later while peers were still shouting).
  const sessionKey = JSON.stringify([
    walletId,
    network,
    cashFusionEnabled,
    p2pFusionEnabled,
  ]);
  useEffect(() => {
    const previousWalletId = previousWalletIdRef.current;
    if (sessionInitializedRef.current && previousWalletId > 0) {
      // Manual and automatic rounds are service-owned, so changing routes does
      // nothing. A real wallet-session boundary must still stop both transports.
      cancelFusionRound(previousWalletId, 'wallet fusion session changed');
    }
    sessionInitializedRef.current = true;
    previousWalletIdRef.current = walletId;
    sessionRef.current += 1;
    activeControllerRef.current?.abort();
    activeControllerRef.current = null;
    if (followUpTimerRef.current) {
      clearTimeout(followUpTimerRef.current);
      followUpTimerRef.current = null;
    }
    // sessionKey (line ~124) already serializes walletId, so this effect DOES
    // re-run on a wallet change; the rule cannot see through JSON.stringify.
    // Listing walletId separately would add nothing and invites re-adding the
    // relay/server arrays this key deliberately excludes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey]);

  const tick = useCallback(
    async (freshSnapshot?: WalletUtxoSnapshot) => {
      if (!policyReady) return;
      if (activeControllerRef.current) return;
      // The recovery poll must be almost free during the durable cooldown: do
      // not probe or start Tor until another automatic attempt is actually due.
      // startFusionRound repeats this advisory check and atomically claims later.
      if (!isAutoCooldownReady(walletId, AUTO_FUSION_COOLDOWN_MS)) return;
      // Depth already satisfied — stay silent until UTXO activity / depth change.
      if (isAutoDepthMetIdle(walletId)) return;
      const controller = new AbortController();
      activeControllerRef.current = controller;
      /** When set, schedule another Auto attempt after this tick (unattended). */
      let requeueMs: number | null = null;

      /** Record a setup/route failure so Auto keeps retrying and the UI explains why. */
      const noteServerSetupFailure = async (message: string) => {
        await stampAutoFailure(walletId, AUTO_FUSION_RETRY_MS).catch(
          () => undefined
        );
        setFusionLastResult(walletId, {
          mode: 'server',
          trigger: 'auto',
          ok: false,
          message,
        });
        void import('./logger')
          .then(({ log }) =>
            log.info('p2p-live', `w${walletId} OUTCOME failed: ${message}`)
          )
          .catch(() => undefined);
        logError('AutoFusion.serverSetup', new Error(message), { walletId });
        requeueMs = AUTO_FUSION_RETRY_MS + 400;
      };

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
          if (!selectedServer) {
            await noteServerSetupFailure(
              'Auto-fuse (server): no fusion server selected — retrying…'
            );
            return;
          }
          try {
            const inputLookupEndpoint = defaultInputLookupEndpoint(network);
            const selected = await selectPreparedFusionServer({
              selected: selectedServer,
              configured: fusionServers,
              prepare: async (server) => {
                const target = parseFusionServerTarget(server);
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
                if (route.type === 'unavailable') {
                  throw new Error(route.reason);
                }
                const tor = route.type === 'tor' ? route.tor : null;
                const hello = await fetchFusionServerStatus(
                  target.host,
                  target.port,
                  target.useSsl,
                  tor ?? undefined
                );
                validateServerHello(hello);
                return buildServerRunner({
                  walletId,
                  network,
                  ...target,
                  tor,
                  inputLookupEndpoint,
                  expectedHello: hello,
                  joinInactiveTimeoutMs: SERVER_AUTOFUSE_INACTIVE_MS,
                });
              },
            });
            torReady = true;
            serverRunner = selected.prepared;
          } catch (error) {
            torReady = false;
            const msg = error instanceof Error ? error.message : String(error);
            await noteServerSetupFailure(
              `Auto-fuse (server): ${msg} — retrying…`
            );
            return;
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

        // UTXO activity (send/receive/tx) must not wait on the rendezvous slot —
        // that delayed wallet6 (id 4) after depth-met idle was cleared. Poll-only
        // ticks still align to the open window so independent clients cluster.
        // Server Auto uses the same idea: shared JoinPools entry window so 4
        // wallets meet (P2P-style), not staggered 2–3 player partial rounds.
        if (!freshSnapshot) {
          const waitMs =
            decision.mode === 'p2p'
              ? msUntilAutoRendezvousOpen()
              : msUntilServerAutoStart();
          if (waitMs > 0) {
            try {
              await sleepMs(waitMs, controller.signal);
            } catch {
              return;
            }
            if (session !== sessionRef.current || controller.signal.aborted) {
              return;
            }
          }
        }

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
              progress?.onStatus?.(
                'Auto-fuse (server): contacting fusion server…'
              );
              return serverRunner(coins, signal, progress);
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
          // EC plugin re-starts autofusion on the next timer; re-queue promptly.
          requeueMs = AUTO_FUSION_RETRY_MS + 400;
        } else if (outcome.status === 'verification-pending') {
          logError(
            'AutoFusion.verificationPending',
            new Error(outcome.message),
            {
              walletId,
              mode: outcome.mode,
              txid: outcome.txid,
            }
          );
          // Wallet sync/activity performs reconciliation. Do not chain another
          // fee-spending round while this signed transaction is still unknown.
          requeueMs = null;
        } else if (outcome.status === 'fused') {
          if (outcome.warning) {
            logError(
              'AutoFusion.completionWarning',
              new Error(outcome.warning),
              {
                walletId,
                mode: outcome.mode,
                txid: outcome.txid,
              }
            );
          }
          // Climb rounds-per-coin unattended: success → short rest → JoinPools again.
          requeueMs = AUTO_FUSION_COOLDOWN_MS + 500;
        } else if (outcome.status === 'cancelled') {
          requeueMs = AUTO_FUSION_RETRY_MS + 400;
        } else if (outcome.status === 'waiting-for-wallet') {
          requeueMs = 4_000;
        } else if (outcome.status === 'cooldown' || outcome.status === 'busy') {
          requeueMs = AUTO_FUSION_RETRY_MS;
        }
        // no-eligible-coins / depth-met: do not requeue — long idle stamp handles it.
      } finally {
        if (activeControllerRef.current === controller) {
          activeControllerRef.current = null;
        }
        // Unattended loop: chain the next attempt without waiting only on the
        // recovery poll. Matches Electron Cash keeping _fusions_auto filled.
        if (
          requeueMs !== null &&
          cashFusionEnabled &&
          autoFuseEnabled &&
          walletId > 0
        ) {
          if (followUpTimerRef.current) clearTimeout(followUpTimerRef.current);
          const delay = requeueMs;
          followUpTimerRef.current = setTimeout(() => {
            followUpTimerRef.current = null;
            void tickRef.current().catch((error) => {
              logError('AutoFusion.requeue', error, { walletId });
            });
          }, delay);
        }
      }
    },
    [
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
      policyReady,
    ]
  );
  tickRef.current = tick;

  /**
   * Rounds-per-coin from the settings box is the live Auto target.
   * Changing the number re-evaluates eligibility: raise → fuse further;
   * lower → stop sooner. Clears depth-met idle and starts Auto immediately.
   */
  const lastFuseDepthRef = useRef<number | null>(null);
  useEffect(() => {
    if (
      !policyReady ||
      !cashFusionEnabled ||
      !autoFuseEnabled ||
      walletId <= 0
    ) {
      lastFuseDepthRef.current = fuseDepth;
      return;
    }
    if (lastFuseDepthRef.current === null) {
      lastFuseDepthRef.current = fuseDepth;
      return;
    }
    if (lastFuseDepthRef.current === fuseDepth) return;
    lastFuseDepthRef.current = fuseDepth;
    void clearAutoCooldown(walletId)
      .then(() =>
        tick().catch((error) => {
          logError('AutoFusion.fuseDepthChanged', error, {
            walletId,
            fuseDepth,
          });
        })
      )
      .catch(() => undefined);
  }, [
    fuseDepth,
    walletId,
    cashFusionEnabled,
    autoFuseEnabled,
    policyReady,
    tick,
  ]);

  useEffect(() => {
    if (!policyReady || !cashFusionEnabled || !autoFuseEnabled || walletId <= 0)
      return;
    let disposed = false;

    const run = (freshSnapshot?: WalletUtxoSnapshot) => {
      if (disposed) return;
      void tick(freshSnapshot).catch((error) => {
        logError('AutoFusion.tick', error, { walletId });
      });
    };

    // Event-driven wake: any committed UTXO change (receive, send, change,
    // any tx — not only "new funds"). That is the beauty trigger beyond depth:
    // if depth-met idle is active and coins are again below rounds-per-coin,
    // clear the long idle and start Auto. Short success/fail cooldowns stay.
    // The interval is only a backstop for missed notifications while climbing depth.
    const unsubscribeRefresh = subscribeWalletUtxoRefresh(
      (refreshedWalletId, snapshot) => {
        if (refreshedWalletId !== walletId || disposed) return;
        void (async () => {
          try {
            const nonToken = Object.values(snapshot)
              .flat()
              .filter((c) => c && !c.token && !c.token_data);
            const below = coinsBelowDepth(walletId, nonToken, fuseDepth);
            await wakeAutoFromWalletActivity(walletId, below.length > 0);
          } catch {
            /* wake is best-effort; still try the tick below */
          }
          if (!disposed) run(snapshot);
        })();
      }
    );
    // Mode-aware recovery poll: server Auto uses a short steady beat so
    // connect-refused / empty-pool keep re-entering the JOIN queue; P2P keeps
    // the shared rendezvous window so peers meet.
    const mode = p2pFusionEnabled ? 'p2p' : 'server';
    const arm = () => nextAutoEngineTickForMode(mode);
    let timer = setTimeout(function tick() {
      void run();
      timer = setTimeout(tick, arm());
    }, arm());
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
    // First tick immediately (EC does not wait a full period to start Auto).
    void run();
    return () => {
      disposed = true;
      unsubscribeRefresh();
      clearTimeout(timer);
      if (followUpTimerRef.current) {
        clearTimeout(followUpTimerRef.current);
        followUpTimerRef.current = null;
      }
    };
  }, [
    cashFusionEnabled,
    autoFuseEnabled,
    walletId,
    p2pFusionEnabled,
    fuseDepth,
    policyReady,
    tick,
  ]);
}
