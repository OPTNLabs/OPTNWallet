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
  selectTorEnabled,
  selectTorAuto,
  selectTorHost,
  selectTorPortManual,
  setCashFusionEnabled,
  setFusionServer,
  addFusionServer,
  removeFusionServer,
} from '../../state/slices/experimentalSlice';
import {
  fetchFusionServerStatus,
  detectTorPort,
  integratedTorStatus,
  FUSION_SUPPORTED,
  type FusionServerStatus,
  type TorConfig,
} from '../../services/fusion/FusionStatusService';

// Ports per Electron Cash's own conf.py default (fusion.servo.cash:8789, SSL).
const DEFAULT_SERVER = 'fusion.servo.cash:8789';

type ConnStatus = 'idle' | 'testing' | 'ok' | 'fail';

function parseHostPort(hostPort: string): { host: string; port: number } {
  const [host, port = '8789'] = hostPort.trim().split(':');
  return { host, port: Number(port) || 8789 };
}

function isLocalHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

const satsToBch = (sats: number) => (sats / 1e8).toLocaleString(undefined, { maximumFractionDigits: 8 });

export const CashFusionSettings: React.FC = () => {
  const dispatch = useDispatch();
  const enabled = useSelector(selectCashFusionEnabled);
  const savedServer = useSelector(selectFusionServer);
  const servers = useSelector(selectFusionServers);
  const torEnabled = useSelector(selectTorEnabled);
  const torAuto = useSelector(selectTorAuto);
  const torHost = useSelector(selectTorHost);
  const torPortManual = useSelector(selectTorPortManual);

  const [serverInput, setServerInput] = useState(savedServer ?? DEFAULT_SERVER);
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
    if (managed.running && managed.bootstrap_percent >= 100 && managed.socks_port > 0) {
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
  function resolveTor(host: string): TorConfig | undefined {
    if (!torEnabled || isLocalHost(host)) return undefined;
    const port = torAuto ? (torDetected && torDetected > 0 ? torDetected : undefined) : torPortManual;
    if (!port) return undefined;
    return { host: torHost, port };
  }

  const handleAddServer = () => {
    // Fusion servers have no labels — keep only the host:port token.
    const target = newServer.trim().split(/\s+/)[0];
    if (target) {
      dispatch(addFusionServer(target));
      setNewServer('');
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
      const { host, port } = parseHostPort(target ?? '');
      try {
        const result = await fetchFusionServerStatus(host, port, true, resolveTor(host));
        setStatus(result);
        setConnStatus('ok');
        if (fusionAuto) {
          setServerInput(target);
          dispatch(setFusionServer(target));
        }
        return;
      } catch (err) {
        errors.push(`${target}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    setErrorMsg(fusionAuto ? `All servers failed — ${errors.join(' | ')}` : errors[0]);
    setConnStatus('fail');
  };

  const connStatusBadge = () => {
    if (connStatus === 'testing') return <span className="text-[10px] wallet-muted animate-pulse">Handshaking…</span>;
    if (connStatus === 'ok')   return <span className="text-[10px] text-green-400 font-semibold">Handshake OK ✓</span>;
    if (connStatus === 'fail') return <span className="text-[10px] text-red-400 font-semibold">Failed ✗</span>;
    return null;
  };

  const selectedHost = parseHostPort(serverInput ?? '').host;
  const torActive = torEnabled && !isLocalHost(selectedHost);
  const torReady = torAuto ? torDetected !== null && torDetected > 0 : true;

  return (
    <div className="flex flex-col gap-4">

      {/* Protocol summary */}
      <div className="rounded-xl border border-blue-400/20 bg-blue-400/5 p-3 space-y-1.5">
        <div className="flex items-center gap-2">
          <p className="text-xs font-semibold text-blue-400">CashFusion</p>
          <span className="rounded-full border border-blue-400/30 bg-blue-400/10 px-2 py-0.5 text-[9px] font-bold text-blue-400 uppercase">
            Privacy
          </span>
        </div>
        <p className="text-xs wallet-muted leading-relaxed">
          CashFusion combines UTXOs from many participants into a single transaction,
          breaking the blockchain history links between inputs and outputs.
          It is non-custodial — your funds never leave your control.
        </p>
        <button
          type="button"
          onClick={() => setShowProtocolInfo(v => !v)}
          className="text-[10px] text-blue-400 underline-offset-2 hover:underline"
        >
          {showProtocolInfo ? 'Hide' : 'How does it work?'}
        </button>
        {showProtocolInfo && (
          <div className="mt-1 rounded-lg border border-[var(--wallet-border)] bg-[var(--wallet-surface)] px-3 py-2 space-y-1.5 text-[10px] wallet-muted leading-relaxed">
            <p><span className="wallet-text-strong">1. Pool joining.</span> Your wallet announces UTXOs it wants to fuse to the server.</p>
            <p><span className="wallet-text-strong">2. Blind signing.</span> Participants generate blinded output addresses and exchange blind signatures — nobody learns the input→output mapping.</p>
            <p><span className="wallet-text-strong">3. Covert submission.</span> Each participant independently submits the transaction via Tor or direct connection. The server assembles the final tx.</p>
            <p><span className="wallet-text-strong">4. Broadcast.</span> All participants broadcast the jointly constructed transaction.</p>
            <p className="text-yellow-400/80 mt-1">
              ⚠ Steps 1–4 (joining a pool and actually fusing coins) are not implemented yet.
              What works today: the wallet speaks the real CashFusion protocol to a server
              and reads its live parameters. Fusing itself needs the blind-signature and
              covert-connection layers, which are deliberately being built and reviewed
              carefully rather than rushed — a subtle bug there could deanonymize the very
              user it is meant to protect.
            </p>
          </div>
        )}
      </div>

      {/* Enable toggle */}
      <div className="rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] p-4 space-y-2">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-semibold wallet-text-strong">CashFusion Enabled</span>
          <button
            onClick={() => dispatch(setCashFusionEnabled(!enabled))}
            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors ${
              enabled
                ? 'bg-[var(--wallet-accent)] border-[var(--wallet-accent)]'
                : 'wallet-surface-strong border-[var(--wallet-border)]'
            }`}
            aria-label={`${enabled ? 'Disable' : 'Enable'} CashFusion`}
          >
            <span className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${enabled ? 'translate-x-5' : 'translate-x-0.5'}`} />
          </button>
        </div>
        {enabled && (
          <p className="text-xs wallet-muted">
            Configure a server below and query it. Note this does not fuse coins yet —
            see the phase note at the bottom.
          </p>
        )}
      </div>

      {/* Fusion servers + phase note only show when CashFusion is enabled, so
          disabling the toggle retracts the whole configuration. */}
      {enabled && (
        <>
      {/* Fusion servers — one unified list, like the Electrum pool. Click a row
          to select it, then Query. Your own servers can be removed. Tor config
          lives in its own panel above (TorSettings); the query uses that shared
          Tor state via resolveTor(). */}
      <div className="rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] p-4 space-y-3">
        <p className="text-xs font-semibold wallet-text-strong">Fusion servers</p>

        <div className="flex flex-col gap-1.5">
          {/* Auto — try each server until one responds (like the Electrum pool) */}
          {servers.length > 1 && (
            <button
              type="button"
              onClick={() => { setFusionAuto(true); setConnStatus('idle'); setStatus(null); }}
              className={`rounded-xl border px-3 py-2 text-left text-xs font-semibold transition-colors ${
                fusionAuto
                  ? 'border-[var(--wallet-accent)] text-[var(--wallet-accent)] bg-[var(--wallet-accent)]/10'
                  : 'border-[var(--wallet-border)] wallet-muted hover:wallet-text-strong'
              }`}
            >
              <span className="flex items-center justify-between gap-2">
                <span>Auto — try each until one responds</span>
                {fusionAuto && <span className="text-[10px] whitespace-nowrap">● active</span>}
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
                onClick={() => { setFusionAuto(false); setServerInput(s); dispatch(setFusionServer(s)); setConnStatus('idle'); setStatus(null); }}
                className="flex-1 text-left break-all"
              >
                <span className="flex items-center justify-between gap-2">
                  <span>{s}</span>
                  {!fusionAuto && (serverInput ?? '') === s && <span className="text-[10px] font-semibold whitespace-nowrap">● selected</span>}
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
              onKeyDown={(e) => { if (e.key === 'Enter') handleAddServer(); }}
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
            disabled={connStatus === 'testing' || !FUSION_SUPPORTED || (!fusionAuto && !(serverInput ?? '').trim())}
            className="rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface-strong)] px-3 py-1.5 text-xs font-semibold wallet-text-strong disabled:opacity-50 hover:brightness-95 transition-all"
          >
            {fusionAuto ? 'Query (Auto)' : 'Query Server'}
          </button>
          {connStatusBadge()}
        </div>

        {!FUSION_SUPPORTED && (
          <p className="text-[10px] wallet-muted leading-relaxed">
            CashFusion needs a raw TCP connection, which a mobile/web browser cannot open.
            Available in the desktop app.
          </p>
        )}
        {FUSION_SUPPORTED && torActive && !torReady && (
          <p className="text-[10px] text-yellow-400/80 leading-relaxed">
            This is a remote server, so Tor is required — but no Tor proxy was found. Start Tor in the
            Tor panel above, or the query will be refused.
          </p>
        )}
        {FUSION_SUPPORTED && !torActive && !isLocalHost(selectedHost) && (
          <p className="text-[10px] text-yellow-400/80 leading-relaxed">
            Tor is off. Remote fusion queries will be refused — enable Tor in the panel above, or use a localhost server.
          </p>
        )}
        {FUSION_SUPPORTED && torActive && torReady && (
          <p className="text-[10px] text-green-400/70 leading-relaxed">
            Connecting via Tor{torAuto && torDetected ? ` (port ${torDetected})` : ''}.
          </p>
        )}
        {connStatus === 'fail' && errorMsg && (
          <p className="text-[10px] text-red-400/80 leading-relaxed">{errorMsg}</p>
        )}

        {/* Real ServerHello data — proof the protocol handshake actually completed. */}
        {status && (
          <div className="rounded-lg border border-green-400/20 bg-green-400/5 px-3 py-2 space-y-1 text-[10px]">
            <p className="font-semibold text-green-400">Server parameters (live)</p>
            <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 wallet-muted">
              <span>Pool tiers</span>
              <span className="wallet-text-strong">{status.tiers.length}</span>
              <span>Components / player</span>
              <span className="wallet-text-strong">{status.numComponents}</span>
              <span>Component fee rate</span>
              <span className="wallet-text-strong">{status.componentFeerate} sats/kB</span>
              <span>Excess fee range</span>
              <span className="wallet-text-strong">{status.minExcessFee}–{status.maxExcessFee} sats</span>
            </div>
            {status.tiers.length > 0 && (
              <p className="wallet-muted pt-0.5">
                Tiers: {status.tiers.slice(0, 4).map(satsToBch).join(', ')} BCH
                {status.tiers.length > 4 && ` … +${status.tiers.length - 4} more`}
              </p>
            )}
            {status.donationAddress && (
              <p className="wallet-muted break-all pt-0.5">Donation: {status.donationAddress}</p>
            )}
          </div>
        )}

        <p className="text-[10px] wallet-muted leading-relaxed">
          CashFusion intentionally has few public servers — a larger anonymity set on fewer servers
          beats being spread thin. Add your own or a community server above.
        </p>
      </div>

      {/* Phase note */}
      <div className="rounded-xl border border-yellow-400/20 bg-yellow-400/5 px-3 py-2">
        <p className="text-[10px] text-yellow-400/80 leading-relaxed">
          Phase 1 (now): real protocol handshake — the wallet talks to fusion servers and
          reads their live parameters. Phase 2: joining pools and fusing coins.
          Your coins are not being fused yet.
        </p>
      </div>
        </>
      )}

    </div>
  );
};
