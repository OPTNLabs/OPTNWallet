// CashFusion server configuration and status panel.
//
// The "Query Server" button performs a REAL CashFusion protocol handshake
// (ClientHello -> ServerHello) via the Rust client and shows the server's
// actual fusion parameters. It joins no pool and signs nothing.
//
// Server and P2P rounds share the wallet-level reservation, completion, and
// automatic-fusion policy while keeping their transports isolated.

import React, { useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import {
  selectCashFusionEnabled,
  selectFusionServer,
  selectFusionServers,
  selectNostrRelays,
  selectP2pFusionEnabled,
  selectFuseDepth,
  selectTorEnabled,
  selectTorAuto,
  selectTorHost,
  selectTorPortManual,
  setCashFusionEnabled,
  setFusionServer,
  addFusionServer,
  removeFusionServer,
  setP2pFusionEnabled,
} from '../../state/slices/experimentalSlice';
import {
  fetchFusionServerStatus,
  detectTorPort,
  integratedTorStatus,
  FUSION_SUPPORTED,
  type FusionServerStatus,
  type TorConfig,
} from '../../services/fusion/FusionStatusService';
import { P2pFusionTransportPreview } from '../nostr/P2pFusionTransportPreview';
import { AutoFusionControls } from './AutoFusionControls';
import {
  getFusionActivity,
  isFusionRunning,
  reconcileIdleFusionState,
  startFusionRound,
  subscribeFusionActivity,
  type FusionActivity,
  type FusionRunOutcome,
} from '../../platform/desktop/FusionRunnerService';

import { runP2pFusion } from '../../platform/desktop/FusionP2pService';
import {
  buildServerRunner,
  defaultInputLookupEndpoint,
  parseFusionServerTarget,
  serverFusionPrivacyDestination,
} from '../../platform/desktop/ServerFusionRunner';
import { resolveFusionTransport } from '../../platform/desktop/FusionTorResolver';
import {
  assertServerFusionSelected,
  getFusionModeAvailability,
} from '../../platform/desktop/FusionMode';
import type { RootState } from '../../state/store';

// Ports per Electron Cash's own conf.py default (fusion.servo.cash:8789, SSL).
/** Typed outcome -> user text, so no caller parses strings to learn what happened. */
function describeFusionOutcome(outcome: FusionRunOutcome): string {
  switch (outcome.status) {
    case 'fused':
      return outcome.warning
        ? `Fused ✓ — txid ${outcome.txid}. ${outcome.warning}`
        : `Fused ✓ — txid ${outcome.txid}`;
    case 'busy':
      return (
        'A fusion round is already active for this wallet in another window. ' +
        'Finish or close that window, then try again.'
      );
    case 'waiting-for-wallet':
      // Not an error: the wallet is mid-refresh. Falling back to the cached coin
      // list here is exactly how a round ends up spending coins that are gone.
      return 'Syncing wallet coins — try again in a moment.';
    case 'no-eligible-coins':
      return 'No coins are eligible to fuse right now.';
    case 'cooldown':
      return 'Waiting for the auto-fusion cooldown.';
    case 'cancelled':
      return 'Fusion stopped because the active wallet session changed.';
    case 'failed':
      return outcome.message;
  }
}

const DEFAULT_SERVER = 'fusion.servo.cash:8789';

type ConnStatus = 'idle' | 'testing' | 'ok' | 'fail';

function isLocalHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

const satsToBch = (sats: number) =>
  (sats / 1e8).toLocaleString(undefined, { maximumFractionDigits: 8 });

// variant 'card' = the CashFusion toggles + fuse actions (CashFusion app entry);
// 'servers' = only the fusion-server list (rendered in the Servers panel).
export const CashFusionSettings: React.FC<{ variant?: 'card' | 'servers' }> = ({
  variant = 'card',
}) => {
  const dispatch = useDispatch();
  const enabled = useSelector(selectCashFusionEnabled);
  const p2pFusionEnabled = useSelector(selectP2pFusionEnabled);
  const savedServer = useSelector(selectFusionServer);
  const servers = useSelector(selectFusionServers);
  const torEnabled = useSelector(selectTorEnabled);
  const torAuto = useSelector(selectTorAuto);
  const torHost = useSelector(selectTorHost);
  const torPortManual = useSelector(selectTorPortManual);
  const nostrRelays = useSelector(selectNostrRelays);

  // walletId/network drive live coin reconciliation before every round.
  const walletId = useSelector((s: RootState) => s.wallet_id.currentWalletId);
  const currentNetwork = useSelector(
    (s: RootState) => s.network.currentNetwork
  );
  // Coin selection belongs to FusionRunnerService, which reconciles live UTXOs.
  // Reading the redux list here is the stale-input path the runner exists to remove.
  const fuseDepth = useSelector(selectFuseDepth);
  const [fuseState, setFuseState] = useState<
    'idle' | 'fusing' | 'done' | 'fail'
  >('idle');
  const [fuseMsg, setFuseMsg] = useState<string | null>(null);
  const [p2pState, setP2pState] = useState<'idle' | 'fusing' | 'done' | 'fail'>(
    'idle'
  );
  const [p2pMsg, setP2pMsg] = useState<string | null>(null);
  const [p2pPhase, setP2pPhase] = useState(0);
  const [fusionActivity, setFusionActivity] = useState<FusionActivity | null>(
    () => getFusionActivity(walletId)
  );
  // Only trust activity when this window actually holds the in-memory lease.
  // Orphan activity used to greyscale the whole panel while nothing was fusing.
  const runningHere = isFusionRunning(walletId);
  const activeFusion =
    runningHere && fusionActivity?.walletId === walletId
      ? fusionActivity
      : null;
  const serverFusing =
    activeFusion?.mode === 'server' || fuseState === 'fusing';
  const p2pFusing = activeFusion?.mode === 'p2p' || p2pState === 'fusing';
  const anyFusing = serverFusing || p2pFusing;
  const serverMode = getFusionModeAvailability({
    p2pFusionEnabled,
    walletId,
    serverBusy: anyFusing,
  });

  // Start from the saved server only if it belongs to the current network's
  // pool; otherwise fall back to the network default (list head) so switching to
  // Chipnet doesn't leave manual mode pointed at the mainnet fusion server.
  const [serverInput, setServerInput] = useState(() =>
    savedServer && servers.includes(savedServer)
      ? savedServer
      : servers[0] ?? DEFAULT_SERVER
  );
  const [fusionAuto, setFusionAuto] = useState(false);
  const [newServer, setNewServer] = useState('');
  const [connStatus, setConnStatus] = useState<ConnStatus>('idle');
  const [status, setStatus] = useState<FusionServerStatus | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [showProtocolInfo, setShowProtocolInfo] = useState(false);

  // Tor port detected for the query below. The Tor config UI lives in
  // TorSettings; here we just resolve the current proxy for resolveTor().
  const [torDetected, setTorDetected] = useState<number | null>(null);

  const refreshTor = React.useCallback(async () => {
    if (!FUSION_SUPPORTED || !torEnabled) return;
    // Prefer the app's integrated Tor if it's running; otherwise fall back to
    // an external Tor the user runs (9050/9150).
    const managed = await integratedTorStatus();
    if (
      managed.running &&
      managed.bootstrap_percent >= 100 &&
      managed.socks_port > 0
    ) {
      setTorDetected(managed.socks_port);
      return;
    }
    const port = await detectTorPort(torHost);
    setTorDetected(port ?? -1);
  }, [torEnabled, torHost]);

  useEffect(() => {
    void refreshTor();
  }, [refreshTor]);

  useEffect(
    () => subscribeFusionActivity(walletId, setFusionActivity),
    [walletId]
  );

  // On open: heal ghosts so the panel is never stuck grey from a dead lease.
  useEffect(() => {
    if (walletId <= 0) return;
    void reconcileIdleFusionState(walletId).then(() => {
      setFusionActivity(getFusionActivity(walletId));
      if (fuseState === 'fusing' && !isFusionRunning(walletId)) {
        setFuseState('idle');
      }
      if (p2pState === 'fusing' && !isFusionRunning(walletId)) {
        setP2pState('idle');
        setP2pPhase(0);
      }
    });
  }, [walletId]);

  // The SOCKS proxy to actually route through, or undefined for a direct
  // connection. Direct is only valid for a localhost server (Electron Cash's
  // one exemption) — for a remote server with no Tor, the Rust side refuses.
  // Resolve the Tor proxy to route through, checked LIVE at query time (not from
  // stale mount-time state) so starting the integrated Tor and then querying
  // works. Priority: integrated Tor (if running) -> external auto-detect ->
  // manual port. Undefined = direct (only valid for a localhost server).
  async function currentTorConfig(
    host: string
  ): Promise<TorConfig | undefined> {
    const route = await resolveFusionTransport(host, {
      enabled: torEnabled,
      auto: torAuto,
      host: torHost,
      manualPort: torPortManual,
      autoStartIntegrated: true,
    });
    if (route.type === 'direct') return undefined;
    if (route.type === 'unavailable') {
      throw new Error(route.reason);
    }
    return route.tor;
  }

  const handleAddServer = () => {
    // Fusion servers have no labels — keep only the host:port token.
    const target = newServer.trim().split(/\s+/)[0];
    if (target) {
      dispatch(addFusionServer(target));
      setNewServer('');
    }
  };

  // Run a real fusion round with the wallet's coins. Only reachable when
  // execution is allowed (chipnet test path); mainnet stays gated by the safety
  // requirements. A round completes only when enough players meet in a tier.
  const handleFuseNow = async () => {
    setFuseMsg(null);
    try {
      assertServerFusionSelected(p2pFusionEnabled);
      setFuseState('fusing');

      // Coins come from startFusionRound's live reconciliation, never from the
      // redux list — a stale list is what produced signed CoinJoins spending
      // coins that were already gone. The server handshake happens INSIDE the
      // runner callback so it runs under the round lease rather than before it.
      const outcome = await startFusionRound({
        walletId,
        network: currentNetwork,
        mode: 'server',
        trigger: 'manual',
        fuseDepth,
        runners: {
          runP2p: () =>
            Promise.reject(new Error('P2P runner invoked in server mode')),
          runServer: async (coins, signal) => {
            const target = parseFusionServerTarget(serverInput ?? '');
            const { host } = target;
            const inputLookupEndpoint =
              defaultInputLookupEndpoint(currentNetwork);
            const privacyDestination = serverFusionPrivacyDestination(
              host,
              inputLookupEndpoint.host
            );
            const tor = await currentTorConfig(privacyDestination);
            return buildServerRunner({
              walletId,
              network: currentNetwork,
              ...target,
              tor: tor ?? null,
              inputLookupEndpoint,
              onServerHello: (hello) =>
                setStatus({
                  ...hello,
                  donationAddress: hello.donationAddress ?? null,
                }),
            })(coins, signal);
          },
        },
      });

      setFuseState(outcome.status === 'fused' ? 'done' : 'fail');
      setFuseMsg(describeFusionOutcome(outcome));
    } catch (e) {
      setFuseState('fail');
      setFuseMsg(e instanceof Error ? e.message : String(e));
    }
  };

  // P2P fusion: no server — meet peers on Nostr over Tor and run the round P2P.
  // Tor is mandatory (resolve the SOCKS proxy; runP2pFusion fails closed without).
  const handleP2pFuse = async () => {
    setP2pState('fusing');
    setP2pMsg(null);
    setP2pPhase(0);
    try {
      const outcome = await startFusionRound({
        walletId,
        network: currentNetwork,
        mode: 'p2p',
        trigger: 'manual',
        fuseDepth,
        runners: {
          runServer: () =>
            Promise.reject(new Error('Server runner invoked in P2P mode')),
          runP2p: async (coins, signal) => {
            const tor = await currentTorConfig('nostr-relay');
            return runP2pFusion({
              walletId,
              network: currentNetwork,
              utxos: coins,
              relays: nostrRelays,
              tor: tor ?? null,
              onStatus: (m) => setP2pMsg(m),
              onPhase: (p) => setP2pPhase(p),
              signal,
            });
          },
        },
      });
      setP2pState(outcome.status === 'fused' ? 'done' : 'fail');
      setP2pMsg(describeFusionOutcome(outcome));
    } catch (e) {
      setP2pState('fail');
      setP2pMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const handleTest = async () => {
    setConnStatus('testing');
    setStatus(null);
    setErrorMsg(null);
    // Auto tries each server in order and stops at the first that responds —
    // the same failover the Electrum pool does. Manual queries only the
    // selected server.
    const targets = fusionAuto ? servers : [serverInput];
    const errors: string[] = [];
    for (const target of targets) {
      try {
        const { host, port, useSsl } = parseFusionServerTarget(target ?? '');
        const torCfg = await currentTorConfig(host);
        const result = await fetchFusionServerStatus(
          host,
          port,
          useSsl,
          torCfg
        );
        setStatus(result);
        setConnStatus('ok');
        if (fusionAuto) {
          setServerInput(target);
          dispatch(setFusionServer(target));
        }
        return;
      } catch (err) {
        errors.push(
          `${target}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    setErrorMsg(
      fusionAuto ? `All servers failed — ${errors.join(' | ')}` : errors[0]
    );
    setConnStatus('fail');
  };

  const connStatusBadge = () => {
    if (connStatus === 'testing')
      return (
        <span className="text-[10px] wallet-muted animate-pulse">
          Handshaking…
        </span>
      );
    if (connStatus === 'ok')
      return (
        <span className="text-[10px] text-green-400 font-semibold">
          Handshake OK ✓
        </span>
      );
    if (connStatus === 'fail')
      return (
        <span className="text-[10px] text-red-400 font-semibold">Failed ✗</span>
      );
    return null;
  };

  let selectedHost = '';
  try {
    selectedHost = parseFusionServerTarget(serverInput ?? '').host;
  } catch {
    // Keep the settings screen usable while the user edits an incomplete host.
  }
  const torActive = torEnabled && !isLocalHost(selectedHost);
  const torReady = torAuto ? torDetected !== null && torDetected > 0 : true;

  return (
    <div className="flex flex-col gap-4">
      {variant === 'card' && (
        <>
          {/* Protocol summary */}
          <div className="rounded-xl border border-blue-400/20 bg-blue-400/5 p-3 space-y-1.5">
            <div className="flex items-center gap-2">
              <p className="text-xs font-semibold text-blue-400">CashFusion</p>
              <span className="rounded-full border border-blue-400/30 bg-blue-400/10 px-2 py-0.5 text-[9px] font-bold text-blue-400 uppercase">
                Privacy
              </span>
            </div>
            <p className="text-xs wallet-muted leading-relaxed">
              CashFusion combines UTXOs from many participants into a single
              transaction, breaking the blockchain history links between inputs
              and outputs. It is non-custodial — your funds never leave your
              control.
            </p>
            <button
              type="button"
              onClick={() => setShowProtocolInfo((v) => !v)}
              className="text-[10px] text-blue-400 underline-offset-2 hover:underline"
            >
              {showProtocolInfo ? 'Hide' : 'How does it work?'}
            </button>
            {showProtocolInfo && (
              <div className="mt-1 rounded-lg border border-[var(--wallet-border)] bg-[var(--wallet-surface)] px-3 py-2 space-y-1.5 text-[10px] wallet-muted leading-relaxed">
                <p>
                  <span className="wallet-text-strong">1. Pool joining.</span>{' '}
                  Your wallet announces UTXOs it wants to fuse to the server.
                </p>
                <p>
                  <span className="wallet-text-strong">2. Blind signing.</span>{' '}
                  Participants generate blinded output addresses and exchange
                  blind signatures — nobody learns the input→output mapping.
                </p>
                <p>
                  <span className="wallet-text-strong">
                    3. Covert submission.
                  </span>{' '}
                  Each participant independently submits the transaction via Tor
                  or direct connection. The server assembles the final tx.
                </p>
                <p>
                  <span className="wallet-text-strong">4. Broadcast.</span> All
                  participants broadcast the jointly constructed transaction.
                </p>
                <p className="wallet-muted mt-1">
                  Steps 1–4 run end-to-end (server path): the wallet joins a
                  pool, exchanges blind signatures, submits over Tor, and
                  broadcasts the assembled CoinJoin. P2P Fusion runs the same
                  round without a server — peers meet on Nostr over Tor.
                  Before signing, the wallet verifies value conservation, fees,
                  and its fresh outputs. Remote Fusion, lookup, and broadcast
                  traffic use native, verified Tor routes.
                </p>
              </div>
            )}
          </div>

          {/* Enable toggle */}
          <div className="rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] p-4 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-semibold wallet-text-strong">
                CashFusion Enabled
              </span>
              <button
                onClick={() => dispatch(setCashFusionEnabled(!enabled))}
                disabled={anyFusing}
                className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors ${
                  enabled
                    ? 'bg-[var(--wallet-accent)] border-[var(--wallet-accent)]'
                    : 'wallet-surface-strong border-[var(--wallet-border)]'
                } disabled:cursor-not-allowed disabled:opacity-50`}
                aria-label={`${enabled ? 'Disable' : 'Enable'} CashFusion`}
              >
                <span
                  className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${enabled ? 'translate-x-5' : 'translate-x-0.5'}`}
                />
              </button>
            </div>
            {enabled && (
              <div className="space-y-3 pt-1">
                <p className="text-xs wallet-muted">
                  Choose how to fuse:{' '}
                  <span className="wallet-text-strong">
                    Fuse Now using CashFusion server
                  </span>{' '}
                  (a server from the Servers card), or{' '}
                  <span className="wallet-text-strong">P2P Fusion</span> (no
                  server — peers over Nostr + Tor). Both run a real CoinJoin.
                </p>

                <div className="rounded-lg border border-[var(--wallet-border)] px-3 py-2.5 space-y-3">
                  {/* Server and P2P are mutually exclusive (one on ⇒ other off). Whichever
                is on auto-fuses on incoming/outgoing coins — no separate Auto Fuse. */}
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-xs font-semibold wallet-text-strong">
                        Server Fusion
                      </p>
                      <p className="text-[10px] wallet-muted leading-relaxed">
                        Fuse via a CashFusion server (from the Servers card).
                        Auto-fuses when on.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => dispatch(setP2pFusionEnabled(false))}
                      disabled={anyFusing}
                      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors ${
                        !p2pFusionEnabled
                          ? 'bg-[var(--wallet-accent)] border-[var(--wallet-accent)]'
                          : 'wallet-surface-strong border-[var(--wallet-border)]'
                      } disabled:cursor-not-allowed disabled:opacity-50`}
                      aria-label="Enable Server Fusion"
                      aria-pressed={!p2pFusionEnabled}
                    >
                      <span
                        className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${!p2pFusionEnabled ? 'translate-x-4' : 'translate-x-0.5'}`}
                      />
                    </button>
                  </div>

                  <div className="flex items-center justify-between gap-3 border-t border-[var(--wallet-border)] pt-3">
                    <div>
                      <p className="text-xs font-semibold wallet-text-strong">
                        P2P Fusion
                      </p>
                      <p className="text-[10px] wallet-muted leading-relaxed">
                        Serverless — peers over Nostr + Tor. Auto-fuses when on.
                        Turning this on turns Server Fusion off.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => dispatch(setP2pFusionEnabled(true))}
                      disabled={anyFusing}
                      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors ${
                        p2pFusionEnabled
                          ? 'bg-[var(--wallet-accent)] border-[var(--wallet-accent)]'
                          : 'wallet-surface-strong border-[var(--wallet-border)]'
                      } disabled:cursor-not-allowed disabled:opacity-50`}
                      aria-label="Enable P2P Fusion"
                      aria-pressed={p2pFusionEnabled}
                    >
                      <span
                        className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${p2pFusionEnabled ? 'translate-x-4' : 'translate-x-0.5'}`}
                      />
                    </button>
                  </div>

                  {/* ONE auto-fusion policy for both transports, placed directly under
                the mode chooser so it reads as governing whichever mode is on.
                Duplicating it per card would let the two copies disagree, and the
                disagreement would only surface when a round used the wrong bound. */}
                  <div className="border-t border-[var(--wallet-border)] pt-3">
                    <AutoFusionControls disabled={walletId <= 0 || anyFusing} />
                  </div>

                  {/* Server path — Fuse Now via the configured CashFusion server (Servers card). */}
                  <div
                    aria-disabled={serverMode.serverDisabled}
                    className={`flex items-center justify-between gap-2 rounded-lg border border-[var(--wallet-accent)]/30 wallet-surface px-3 py-2 transition-opacity ${
                      serverMode.serverMuted ? 'opacity-40 grayscale' : ''
                    }`}
                  >
                    <div>
                      <p className="text-xs font-semibold wallet-text-strong">
                        Fuse Now using CashFusion server
                      </p>
                      <p className="text-[10px] wallet-muted">
                        CoinJoin via the server configured in Servers. Needs Tor
                        + ≥2 players in a tier.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleFuseNow()}
                      disabled={serverMode.serverDisabled}
                      className="rounded-lg border border-[var(--wallet-accent)]/50 px-3 py-1.5 text-xs font-semibold text-[var(--wallet-accent)] hover:bg-[var(--wallet-accent)]/5 disabled:opacity-50 whitespace-nowrap"
                    >
                      {serverFusing ? 'Fusing…' : 'Fuse Now'}
                    </button>
                  </div>
                  {fuseMsg && (
                    <p
                      className={`text-[10px] leading-relaxed break-all ${
                        fuseState === 'done'
                          ? 'text-green-400'
                          : fuseState === 'fail'
                            ? 'text-red-400/90'
                            : 'wallet-muted'
                      }`}
                    >
                      {fuseMsg}
                    </p>
                  )}

                  {/* P2P path — its own Start button + live status (server-free). */}
                  {p2pFusionEnabled && (
                    <P2pFusionTransportPreview
                      onStart={() => void handleP2pFuse()}
                      status={p2pMsg}
                      phase={p2pPhase}
                      busy={p2pFusing}
                      disabled={walletId <= 0 || anyFusing}
                      disabledReason={
                        walletId <= 0
                          ? 'Open a wallet to run a P2P round.'
                          : undefined
                      }
                    />
                  )}
                </div>
              </div>
            )}
          </div>
        </>
      )}

      {/* Fusion server list — lives in the Servers panel (variant='servers'),
          shown regardless of the enable toggle (which is on the CashFusion card). */}
      {variant === 'servers' && (
        <>
          {/* Fusion servers — one unified list, like the Electrum pool. Click a row
          to select it, then Query. Your own servers can be removed. Tor config
          lives in its own panel above (TorSettings); the query uses that shared
          Tor state via resolveTor(). */}
          <div className="rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] p-4 space-y-3">
            <p className="text-xs font-semibold wallet-text-strong">
              Fusion servers
            </p>

            <div className="flex flex-col gap-1.5">
              {/* Auto — try each server until one responds (like the Electrum pool) */}
              {servers.length > 1 && (
                <button
                  type="button"
                  onClick={() => {
                    setFusionAuto(true);
                    setConnStatus('idle');
                    setStatus(null);
                  }}
                  className={`rounded-xl border px-3 py-2 text-left text-xs font-semibold transition-colors ${
                    fusionAuto
                      ? 'border-[var(--wallet-accent)] text-[var(--wallet-accent)] bg-[var(--wallet-accent)]/10'
                      : 'border-[var(--wallet-border)] wallet-muted hover:wallet-text-strong'
                  }`}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span>Auto — try each until one responds</span>
                    {fusionAuto && (
                      <span className="text-[10px] whitespace-nowrap">
                        ● active
                      </span>
                    )}
                  </span>
                </button>
              )}
              {servers.map((s) => (
                <div
                  key={s}
                  className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-mono transition-colors ${
                    !fusionAuto && (serverInput ?? '') === s
                      ? 'border-[var(--wallet-accent)] text-[var(--wallet-accent)] bg-[var(--wallet-accent)]/10'
                      : 'border-[var(--wallet-border)] wallet-muted hover:wallet-text-strong'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => {
                      setFusionAuto(false);
                      setServerInput(s);
                      dispatch(setFusionServer(s));
                      setConnStatus('idle');
                      setStatus(null);
                    }}
                    className="flex-1 text-left break-all"
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span>{s}</span>
                      {!fusionAuto && (serverInput ?? '') === s && (
                        <span className="text-[10px] font-semibold whitespace-nowrap">
                          ● selected
                        </span>
                      )}
                    </span>
                  </button>
                  {servers.length > 1 && (
                    <button
                      type="button"
                      onClick={() => dispatch(removeFusionServer(s))}
                      className="text-[10px] text-red-400/70 hover:text-red-400 px-1 shrink-0"
                      aria-label={`Remove ${s}`}
                    >
                      Remove
                    </button>
                  )}
                </div>
              ))}

              {/* Add a fusion server */}
              <div className="flex gap-2 pt-1">
                <input
                  type="text"
                  value={newServer}
                  onChange={(e) => setNewServer(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleAddServer();
                  }}
                  placeholder="Add server — host:port (e.g. fusion.example.com:8789)"
                  className="flex-1 rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] px-3 py-2 font-mono text-xs wallet-text-strong placeholder:wallet-muted focus:outline-none focus:border-[var(--wallet-accent)]/60"
                />
                <button
                  type="button"
                  onClick={handleAddServer}
                  disabled={!newServer.trim()}
                  className="rounded-xl border border-[var(--wallet-accent)]/40 px-3 py-2 text-xs font-semibold text-[var(--wallet-accent)] hover:bg-[var(--wallet-accent)]/5 disabled:opacity-40 transition-colors"
                >
                  Add
                </button>
              </div>
            </div>

            {/* Query the selected server */}
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => void handleTest()}
                disabled={
                  connStatus === 'testing' ||
                  !FUSION_SUPPORTED ||
                  (!fusionAuto && !(serverInput ?? '').trim())
                }
                className="rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface-strong)] px-3 py-1.5 text-xs font-semibold wallet-text-strong disabled:opacity-50 hover:brightness-95 transition-all"
              >
                {fusionAuto ? 'Query (Auto)' : 'Query Server'}
              </button>
              {connStatusBadge()}
            </div>

            {!FUSION_SUPPORTED && (
              <p className="text-[10px] wallet-muted leading-relaxed">
                CashFusion needs a raw TCP connection, which a mobile/web
                browser cannot open. Available in the desktop app.
              </p>
            )}
            {FUSION_SUPPORTED && torActive && !torReady && (
              <p className="text-[10px] text-yellow-400/80 leading-relaxed">
                This is a remote server, so Tor is required — but no Tor proxy
                was found. Start Tor in the Tor panel above, or the query will
                be refused.
              </p>
            )}
            {FUSION_SUPPORTED && !torActive && !isLocalHost(selectedHost) && (
              <p className="text-[10px] text-yellow-400/80 leading-relaxed">
                Tor is off. Remote fusion queries will be refused — enable Tor
                in the panel above, or use a localhost server.
              </p>
            )}
            {FUSION_SUPPORTED && torActive && torReady && (
              <p className="text-[10px] text-green-400/70 leading-relaxed">
                Connecting via Tor
                {torAuto && torDetected ? ` (port ${torDetected})` : ''}.
              </p>
            )}
            {connStatus === 'fail' && errorMsg && (
              <p className="text-[10px] text-red-400/80 leading-relaxed">
                {errorMsg}
              </p>
            )}

            {/* Real ServerHello data — proof the protocol handshake actually completed. */}
            {status && (
              <div className="rounded-lg border border-green-400/20 bg-green-400/5 px-3 py-2 space-y-1 text-[10px]">
                <p className="font-semibold text-green-400">
                  Server parameters (live)
                </p>
                <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 wallet-muted">
                  <span>Pool tiers</span>
                  <span className="wallet-text-strong">
                    {status.tiers.length}
                  </span>
                  <span>Components / player</span>
                  <span className="wallet-text-strong">
                    {status.numComponents}
                  </span>
                  <span>Component fee rate</span>
                  <span className="wallet-text-strong">
                    {status.componentFeerate} sats/kB
                  </span>
                  <span>Excess fee range</span>
                  <span className="wallet-text-strong">
                    {status.minExcessFee}–{status.maxExcessFee} sats
                  </span>
                </div>
                {status.tiers.length > 0 && (
                  <p className="wallet-muted pt-0.5">
                    Tiers: {status.tiers.slice(0, 4).map(satsToBch).join(', ')}{' '}
                    BCH
                    {status.tiers.length > 4 &&
                      ` … +${status.tiers.length - 4} more`}
                  </p>
                )}
                {status.donationAddress && (
                  <p className="wallet-muted break-all pt-0.5">
                    Donation: {status.donationAddress}
                  </p>
                )}
              </div>
            )}

            <p className="text-[10px] wallet-muted leading-relaxed">
              CashFusion intentionally has few public servers — a larger
              anonymity set on fewer servers beats being spread thin. Add your
              own or a community server above.
            </p>
          </div>
        </>
      )}

      {/* Shared safety summary (CashFusion card only). */}
      {variant === 'card' && enabled && (
        <div className="rounded-xl border border-[var(--wallet-border)] wallet-surface px-3 py-2">
          <p className="text-[10px] wallet-muted leading-relaxed">
            Server and P2P Fusion share the same automatic-fusion policy. Each
            round reserves its inputs and verifies value, fees, and your fresh
            outputs before signing.
          </p>
        </div>
      )}
    </div>
  );
};
