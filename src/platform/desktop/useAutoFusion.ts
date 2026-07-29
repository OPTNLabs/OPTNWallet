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
  selectP2pFusionEnabled,
  selectTorEnabled,
} from '../../state/slices/experimentalSlice';
import type { RootState } from '../../state/store';
import { integratedTorStatus } from './FusionStatusService';
import { decideAutoFusion } from './fusionAutoEngine';
import { startFusionRound } from './FusionRunnerService';
import { runP2pFusion } from './FusionP2pService';
import { logError } from '../../utils/errorHandling';

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
  const walletId = useSelector(
    (state: RootState) => state.wallet_id.currentWalletId
  );
  const network = useSelector(
    (state: RootState) => state.network.currentNetwork
  );

  /** Bumped whenever the wallet session changes, to strand stale completions. */
  const sessionRef = useRef(0);
  useEffect(() => {
    sessionRef.current += 1;
  }, [walletId, network]);

  const tick = useCallback(async () => {
    const session = sessionRef.current;

    // Tor readiness is read live rather than from mount-time state: the user can
    // start Tor at any moment, and a stale "not ready" would keep auto-fusion off
    // long after it became available.
    let torReady = false;
    if (torEnabled) {
      try {
        const status = await integratedTorStatus();
        torReady =
          status.running &&
          status.bootstrap_percent >= 100 &&
          status.socks_port > 0;
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
    if (!decision.run) return;

    // The wallet may have been switched or locked while Tor was queried.
    if (session !== sessionRef.current) return;

    const outcome = await startFusionRound({
      walletId,
      network,
      mode: decision.mode,
      trigger: 'auto',
      fuseDepth,
      runners: {
        runP2p: async (coins) => {
          const status = await integratedTorStatus();
          return runP2pFusion({
            walletId,
            network,
            utxos: coins,
            tor: { host: '127.0.0.1', port: status.socks_port },
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
    }
  }, [
    cashFusionEnabled,
    autoFuseEnabled,
    p2pFusionEnabled,
    fuseDepth,
    torEnabled,
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

    // No immediate run on mount: opening a wallet should not instantly spend a
    // fee, and the wallet's coins are usually still reconciling at that point.
    const timer = setInterval(run, ENGINE_TICK_MS);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [cashFusionEnabled, autoFuseEnabled, walletId, tick]);
}
