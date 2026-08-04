// CashFusion server configuration and status panel.
//
// The "Query Server" button performs a REAL CashFusion protocol handshake
// (ClientHello -> ServerHello) via the Rust client and shows the server's
// actual fusion parameters. It joins no pool and signs nothing.
//
// Fusion round participation (blind signatures, covert connections) is a
// later phase — see docs/cashfusion-implementation-scope.md.

import React, { useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import {
  selectCashFusionEnabled,
  selectFusionServer,
  selectFusionServers,
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
import { CURRENT_FUSION_EXECUTION_READINESS } from '../../platform/desktop/FusionExecutionSafety';
import { P2pFusionTransportPreview } from '../nostr/P2pFusionTransportPreview';
import { AutoFusionControls } from './AutoFusionControls';
import {
  startFusionRound,
  type FusionRunOutcome,
} from '../../platform/desktop/FusionRunnerService';

import { runFusion } from '../../platform/desktop/FusionService';
import { runP2pFusion } from '../../platform/desktop/FusionP2pService';
import {
  assertServerFusionSelected,
  getFusionModeAvailability,
} from '../../platform/desktop/FusionMode';
import type { RootState } from '../../state/store';
import { useI18n } from '../../i18n/useI18n';
import type { TranslationKey } from '../../i18n/resources';

// Ports per Electron Cash's own conf.py default (fusion.servo.cash:8789, SSL).
/** Typed outcome -> user text, so no caller parses strings to learn what happened. */
function describeFusionOutcome(
  outcome: FusionRunOutcome,
  t: (key: TranslationKey, values?: Record<string, string | number>) => string
): string {
  switch (outcome.status) {
    case 'fused':
      return t('fusion.fused', { txid: outcome.txid });
    case 'busy':
      return t('fusion.busy');
    case 'waiting-for-wallet':
      // Not an error: the wallet is mid-refresh. Falling back to the cached coin
      // list here is exactly how a round ends up spending coins that are gone.
      return t('fusion.syncingCoins');
    case 'no-eligible-coins':
      return t('fusion.noEligibleCoins');
    case 'cooldown':
      return t('fusion.cooldown');
    case 'failed':
      return outcome.message;
  }
}

const DEFAULT_SERVER = 'fusion.servo.cash:8789';

type ConnStatus = 'idle' | 'testing' | 'ok' | 'fail';

function parseHostPort(hostPort: string): {
  host: string;
  port: number;
  ssl: boolean;
} {
  const parts = hostPort.trim().split(':');
  const host = parts[0];
  const port = Number(parts[1]) || 8789;
  // Same convention as the Electrum server pool: an optional ':t' suffix means
  // plain TCP (no TLS); ':s' or no suffix means SSL. So a non-SSL/non-wss fusion
  // server is just `host:port:t`.
  const ssl = parts[2] !== 't';
  return { host, port, ssl };
}

function isLocalHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

const satsToBch = (sats: number) =>
  (sats / 1e8).toLocaleString(undefined, { maximumFractionDigits: 8 });
const fusionExecutionReadiness = CURRENT_FUSION_EXECUTION_READINESS;

// variant 'card' = the CashFusion toggles + fuse actions (CashFusion app entry);
// 'servers' = only the fusion-server list (rendered in the Servers panel).
export const CashFusionSettings: React.FC<{ variant?: 'card' | 'servers' }> = ({
  variant = 'card',
}) => {
  const dispatch = useDispatch();
  const { t } = useI18n();
  const enabled = useSelector(selectCashFusionEnabled);
  const p2pFusionEnabled = useSelector(selectP2pFusionEnabled);
  const savedServer = useSelector(selectFusionServer);
  const servers = useSelector(selectFusionServers);
  const torEnabled = useSelector(selectTorEnabled);
  const torAuto = useSelector(selectTorAuto);
  const torHost = useSelector(selectTorHost);
  const torPortManual = useSelector(selectTorPortManual);

  // Fusion execution (chipnet test path). walletId/network/UTXOs drive Fuse Now.
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
  const serverMode = getFusionModeAvailability({
    p2pFusionEnabled,
    walletId,
    serverBusy: fuseState === 'fusing',
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
    if (!torEnabled || isLocalHost(host)) return undefined;
    const managed = await integratedTorStatus();
    if (
      managed.running &&
      managed.bootstrap_percent >= 100 &&
      managed.socks_port > 0
    ) {
      return { host: torHost, port: managed.socks_port };
    }
    if (torAuto) {
      const port = await detectTorPort(torHost);
      return port ? { host: torHost, port } : undefined;
    }
    return { host: torHost, port: torPortManual };
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
          runServer: async (coins) => {
            const { host, port, ssl } = parseHostPort(serverInput ?? '');
            const tor = await currentTorConfig(host);
            const params =
              status ?? (await fetchFusionServerStatus(host, port, ssl, tor));
            if (!status) setStatus(params);

            const result = await runFusion({
              walletId,
              network: currentNetwork,
              host,
              port,
              useSsl: ssl,
              utxos: coins,
              params: {
                tiers: params.tiers,
                numComponents: params.numComponents,
                componentFeerate: params.componentFeerate,
                minExcessFee: params.minExcessFee,
                maxExcessFee: params.maxExcessFee,
              },
              torHost: tor?.host ?? null,
              torPort: tor?.port ?? null,
            });
            if (!result.ok || !result.txid) {
              throw new Error(result.message || 'Server fusion failed.');
            }
            return { txid: result.txid };
          },
        },
      });

      setFuseState(outcome.status === 'fused' ? 'done' : 'fail');
      setFuseMsg(describeFusionOutcome(outcome, t));
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
          runP2p: async (coins) => {
            const tor = await currentTorConfig('nostr-relay');
            return runP2pFusion({
              walletId,
              network: currentNetwork,
              utxos: coins,
              tor: tor ?? null,
              onStatus: (m) => setP2pMsg(m),
              onPhase: (p) => setP2pPhase(p),
            });
          },
        },
      });
      setP2pState(outcome.status === 'fused' ? 'done' : 'fail');
      setP2pMsg(describeFusionOutcome(outcome, t));
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
      const { host, port, ssl } = parseHostPort(target ?? '');
      try {
        const torCfg = await currentTorConfig(host);
        const result = await fetchFusionServerStatus(host, port, ssl, torCfg);
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
          {t('fusion.handshaking')}
        </span>
      );
    if (connStatus === 'ok')
      return (
        <span className="text-[10px] text-green-400 font-semibold">
          {t('fusion.handshakeOk')}
        </span>
      );
    if (connStatus === 'fail')
      return (
        <span className="text-[10px] text-red-400 font-semibold">
          {t('fusion.failed')}
        </span>
      );
    return null;
  };

  const selectedHost = parseHostPort(serverInput ?? '').host;
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
                {t('fusion.privacy')}
              </span>
            </div>
            <p className="text-xs wallet-muted leading-relaxed">
              {t('fusion.summary')}
            </p>
            <button
              type="button"
              onClick={() => setShowProtocolInfo((v) => !v)}
              className="text-[10px] text-blue-400 underline-offset-2 hover:underline"
            >
              {showProtocolInfo ? t('fusion.hide') : t('fusion.howWorks')}
            </button>
            {showProtocolInfo && (
              <div className="mt-1 rounded-lg border border-[var(--wallet-border)] bg-[var(--wallet-surface)] px-3 py-2 space-y-1.5 text-[10px] wallet-muted leading-relaxed">
                <p>
                  <span className="wallet-text-strong">
                    {t('fusion.step1')}
                  </span>{' '}
                  {t('fusion.step1Text')}
                </p>
                <p>
                  <span className="wallet-text-strong">
                    {t('fusion.step2')}
                  </span>{' '}
                  {t('fusion.step2Text')}
                </p>
                <p>
                  <span className="wallet-text-strong">
                    {t('fusion.step3')}
                  </span>{' '}
                  {t('fusion.step3Text')}
                </p>
                <p>
                  <span className="wallet-text-strong">
                    {t('fusion.step4')}
                  </span>{' '}
                  {t('fusion.step4Text')}
                </p>
                <p className="text-yellow-400/80 mt-1">
                  {t('fusion.protocolNote')}
                </p>
              </div>
            )}
          </div>

          {/* Enable toggle */}
          <div className="rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] p-4 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-semibold wallet-text-strong">
                {t('fusion.enabled')}
              </span>
              <button
                onClick={() => dispatch(setCashFusionEnabled(!enabled))}
                className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors ${
                  enabled
                    ? 'bg-[var(--wallet-accent)] border-[var(--wallet-accent)]'
                    : 'wallet-surface-strong border-[var(--wallet-border)]'
                }`}
                aria-label={`${enabled ? t('fusion.disable') : t('fusion.enable')} CashFusion`}
              >
                <span
                  className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${enabled ? 'translate-x-5' : 'translate-x-0.5'}`}
                />
              </button>
            </div>
            {enabled && (
              <div className="space-y-3 pt-1">
                <p className="text-xs wallet-muted">
                  {t('fusion.choose')}{' '}
                  <span className="wallet-text-strong">
                    {t('fusion.serverMode')}
                  </span>{' '}
                  ({t('server.server')}), {t('fusion.or')}{' '}
                  <span className="wallet-text-strong">
                    {t('fusion.p2pMode')}
                  </span>{' '}
                  (no server — peers over Nostr + Tor).{' '}
                  {t('fusion.coinjoinBoth')}
                </p>

                <div className="rounded-lg border border-[var(--wallet-border)] px-3 py-2.5 space-y-3">
                  {/* Server and P2P are mutually exclusive (one on ⇒ other off). Whichever
                is on auto-fuses on incoming/outgoing coins — no separate Auto Fuse. */}
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-xs font-semibold wallet-text-strong">
                        {t('fusion.serverModeLabel')}
                      </p>
                      <p className="text-[10px] wallet-muted leading-relaxed">
                        {t('fusion.serverModeDescription')}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => dispatch(setP2pFusionEnabled(false))}
                      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors ${
                        !p2pFusionEnabled
                          ? 'bg-[var(--wallet-accent)] border-[var(--wallet-accent)]'
                          : 'wallet-surface-strong border-[var(--wallet-border)]'
                      }`}
                      aria-label={t('fusion.enableServer')}
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
                        {t('fusion.p2pModeLabel')}
                      </p>
                      <p className="text-[10px] wallet-muted leading-relaxed">
                        {t('fusion.p2pModeDescription')}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => dispatch(setP2pFusionEnabled(true))}
                      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors ${
                        p2pFusionEnabled
                          ? 'bg-[var(--wallet-accent)] border-[var(--wallet-accent)]'
                          : 'wallet-surface-strong border-[var(--wallet-border)]'
                      }`}
                      aria-label={t('fusion.enableP2p')}
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
                    <AutoFusionControls disabled={walletId <= 0} />
                  </div>

                  {/* Experimental notice — execution runs on ALL networks (owner opt-in).
                These hardening items are still pending; you're informed, not blocked.
                Your own outputs are verified before signing on every network. */}
                  <p className="text-[10px] text-yellow-400/80 leading-relaxed">
                    {t('fusion.experimentalPending', {
                      items: fusionExecutionReadiness.blockers.join(', '),
                    })}
                  </p>

                  {/* Server path — Fuse Now via the configured CashFusion server (Servers card). */}
                  <div
                    aria-disabled={serverMode.serverDisabled}
                    className={`flex items-center justify-between gap-2 rounded-lg border border-[var(--wallet-accent)]/30 wallet-surface px-3 py-2 transition-opacity ${
                      serverMode.serverMuted ? 'opacity-40 grayscale' : ''
                    }`}
                  >
                    <div>
                      <p className="text-xs font-semibold wallet-text-strong">
                        {t('fusion.serverMode')}
                      </p>
                      <p className="text-[10px] wallet-muted">
                        {t('fusion.nowDescription')}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleFuseNow()}
                      disabled={serverMode.serverDisabled}
                      className="rounded-lg border border-[var(--wallet-accent)]/50 px-3 py-1.5 text-xs font-semibold text-[var(--wallet-accent)] hover:bg-[var(--wallet-accent)]/5 disabled:opacity-50 whitespace-nowrap"
                    >
                      {fuseState === 'fusing'
                        ? t('fusion.fusing')
                        : t('fusion.now')}
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
                      busy={p2pState === 'fusing'}
                      disabled={walletId <= 0}
                      disabledReason={
                        walletId <= 0 ? t('fusion.openWallet') : undefined
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
              {t('fusion.servers')}
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
                    <span>{t('fusion.autoTry')}</span>
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
                          {t('fusion.selected')}
                        </span>
                      )}
                    </span>
                  </button>
                  {servers.length > 1 && (
                    <button
                      type="button"
                      onClick={() => dispatch(removeFusionServer(s))}
                      className="text-[10px] text-red-400/70 hover:text-red-400 px-1 shrink-0"
                      aria-label={`${t('server.remove')} ${s}`}
                    >
                      {t('server.remove')}
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
                  placeholder={t('fusion.addPlaceholder')}
                  className="flex-1 rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] px-3 py-2 font-mono text-xs wallet-text-strong placeholder:wallet-muted focus:outline-none focus:border-[var(--wallet-accent)]/60"
                />
                <button
                  type="button"
                  onClick={handleAddServer}
                  disabled={!newServer.trim()}
                  className="rounded-xl border border-[var(--wallet-accent)]/40 px-3 py-2 text-xs font-semibold text-[var(--wallet-accent)] hover:bg-[var(--wallet-accent)]/5 disabled:opacity-40 transition-colors"
                >
                  {t('server.add')}
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
                {fusionAuto ? t('fusion.queryAuto') : t('fusion.queryServer')}
              </button>
              {connStatusBadge()}
            </div>

            {!FUSION_SUPPORTED && (
              <p className="text-[10px] wallet-muted leading-relaxed">
                {t('fusion.mobileUnsupported')}
              </p>
            )}
            {FUSION_SUPPORTED && torActive && !torReady && (
              <p className="text-[10px] text-yellow-400/80 leading-relaxed">
                {t('fusion.remoteTorRequired')}
              </p>
            )}
            {FUSION_SUPPORTED && !torActive && !isLocalHost(selectedHost) && (
              <p className="text-[10px] text-yellow-400/80 leading-relaxed">
                {t('fusion.torOff')}
              </p>
            )}
            {FUSION_SUPPORTED && torActive && torReady && (
              <p className="text-[10px] text-green-400/70 leading-relaxed">
                {t('fusion.connectingTor', {
                  port: torAuto && torDetected ? ` (port ${torDetected})` : '',
                })}
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
                  {t('fusion.serverParameters')}
                </p>
                <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 wallet-muted">
                  <span>{t('fusion.poolTiers')}</span>
                  <span className="wallet-text-strong">
                    {status.tiers.length}
                  </span>
                  <span>{t('fusion.componentsPlayer')}</span>
                  <span className="wallet-text-strong">
                    {status.numComponents}
                  </span>
                  <span>{t('fusion.componentFeeRate')}</span>
                  <span className="wallet-text-strong">
                    {status.componentFeerate} sats/kB
                  </span>
                  <span>{t('fusion.excessFeeRange')}</span>
                  <span className="wallet-text-strong">
                    {status.minExcessFee}–{status.maxExcessFee} sats
                  </span>
                </div>
                {status.tiers.length > 0 && (
                  <p className="wallet-muted pt-0.5">
                    {t('fusion.tiers')}:{' '}
                    {status.tiers.slice(0, 4).map(satsToBch).join(', ')} BCH
                    {status.tiers.length > 4 &&
                      ` … +${status.tiers.length - 4} ${t('fusion.more')}`}
                  </p>
                )}
                {status.donationAddress && (
                  <p className="wallet-muted break-all pt-0.5">
                    {t('fusion.donation')}: {status.donationAddress}
                  </p>
                )}
              </div>
            )}

            <p className="text-[10px] wallet-muted leading-relaxed">
              {t('fusion.fewServers')}
            </p>
          </div>
        </>
      )}

      {/* Experimental note (CashFusion card only) */}
      {variant === 'card' && enabled && (
        <div className="rounded-xl border border-yellow-400/20 bg-yellow-400/5 px-3 py-2">
          <p className="text-[10px] text-yellow-400/80 leading-relaxed">
            {t('fusion.coinjoinAnyNetwork')}
          </p>
        </div>
      )}
    </div>
  );
};
