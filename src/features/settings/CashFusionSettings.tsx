// CashFusion server configuration and status panel.
//
// The "Query Server" button performs a REAL CashFusion protocol handshake
// (ClientHello -> ServerHello) via the Rust client and shows the server's
// actual fusion parameters. It joins no pool and signs nothing.
//
// Fusion round participation (blind signatures, covert connections) is a
// later phase — see docs/cashfusion-implementation-scope.md.

import React, { useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import {
  selectCashFusionEnabled,
  selectFusionServer,
  setCashFusionEnabled,
  setFusionServer,
} from '../../state/slices/experimentalSlice';
import {
  fetchFusionServerStatus,
  FUSION_SUPPORTED,
  type FusionServerStatus,
} from '../../services/fusion/FusionStatusService';

// Ports per Electron Cash's own conf.py default (fusion.servo.cash:8789, SSL).
const DEFAULT_SERVER = 'fusion.servo.cash:8789';

const KNOWN_SERVERS = [
  { label: 'fusion.servo.cash (mainnet)', host: DEFAULT_SERVER },
  { label: 'cashfusion.electroncash.dk (mainnet)', host: 'cashfusion.electroncash.dk:8789' },
];

type ConnStatus = 'idle' | 'testing' | 'ok' | 'fail';

function parseHostPort(hostPort: string): { host: string; port: number } {
  const [host, port = '8789'] = hostPort.trim().split(':');
  return { host, port: Number(port) || 8789 };
}

const satsToBch = (sats: number) => (sats / 1e8).toLocaleString(undefined, { maximumFractionDigits: 8 });

export const CashFusionSettings: React.FC = () => {
  const dispatch = useDispatch();
  const enabled = useSelector(selectCashFusionEnabled);
  const savedServer = useSelector(selectFusionServer);

  const [serverInput, setServerInput] = useState(savedServer ?? DEFAULT_SERVER);
  const [connStatus, setConnStatus] = useState<ConnStatus>('idle');
  const [status, setStatus] = useState<FusionServerStatus | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [showProtocolInfo, setShowProtocolInfo] = useState(false);

  const handleSaveServer = () => {
    const trimmed = (serverInput ?? '').trim();
    if (trimmed) dispatch(setFusionServer(trimmed));
  };

  const handleTest = async () => {
    setConnStatus('testing');
    setStatus(null);
    setErrorMsg(null);
    const { host, port } = parseHostPort(serverInput ?? '');
    try {
      const result = await fetchFusionServerStatus(host, port, true);
      setStatus(result);
      setConnStatus('ok');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setConnStatus('fail');
    }
  };

  const connStatusBadge = () => {
    if (connStatus === 'testing') return <span className="text-[10px] wallet-muted animate-pulse">Handshaking…</span>;
    if (connStatus === 'ok')   return <span className="text-[10px] text-green-400 font-semibold">Handshake OK ✓</span>;
    if (connStatus === 'fail') return <span className="text-[10px] text-red-400 font-semibold">Failed ✗</span>;
    return null;
  };

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

      {/* Server configuration */}
      <div className="rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] p-4 space-y-3">
        <p className="text-xs font-semibold wallet-text-strong">Server</p>

        <div className="flex gap-2">
          <input
            type="text"
            value={serverInput}
            onChange={(e) => { setServerInput(e.target.value); setConnStatus('idle'); }}
            placeholder="host:port (e.g. cashfusion.electroncash.dk:8787)"
            className="flex-1 rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface-strong)] px-3 py-2 font-mono text-xs wallet-text-strong placeholder:wallet-muted focus:outline-none focus:border-[var(--wallet-accent)]/60"
          />
          <button
            type="button"
            onClick={handleSaveServer}
            className="rounded-xl border border-[var(--wallet-accent)]/40 px-3 py-2 text-xs font-semibold text-[var(--wallet-accent)] hover:bg-[var(--wallet-accent)]/5 transition-colors whitespace-nowrap"
          >
            Save
          </button>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => void handleTest()}
            disabled={connStatus === 'testing' || !FUSION_SUPPORTED || !(serverInput ?? '').trim()}
            className="rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface-strong)] px-3 py-1.5 text-xs font-semibold wallet-text-strong disabled:opacity-50 hover:brightness-95 transition-all"
          >
            Query Server
          </button>
          {connStatusBadge()}
        </div>

        {!FUSION_SUPPORTED && (
          <p className="text-[10px] wallet-muted leading-relaxed">
            CashFusion needs a raw TCP connection, which a mobile/web browser cannot open.
            Available in the desktop app.
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
      </div>

      {/* Known servers */}
      <div className="rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] p-4 space-y-2">
        <p className="text-xs font-semibold wallet-text-strong">Known Public Servers</p>
        <div className="space-y-1.5">
          {KNOWN_SERVERS.map((s) => (
            <button
              key={s.host}
              type="button"
              onClick={() => { setServerInput(s.host); setConnStatus('idle'); }}
              className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                (serverInput ?? '') === s.host
                  ? 'border-[var(--wallet-accent)]/50 bg-[var(--wallet-accent)]/10'
                  : 'border-[var(--wallet-border)] bg-[var(--wallet-surface-strong)] hover:brightness-95'
              }`}
            >
              <p className="text-xs wallet-text-strong">{s.label}</p>
              <p className="font-mono text-[10px] wallet-muted">{s.host}</p>
            </button>
          ))}
        </div>
      </div>

      {/* Phase note */}
      <div className="rounded-xl border border-yellow-400/20 bg-yellow-400/5 px-3 py-2">
        <p className="text-[10px] text-yellow-400/80 leading-relaxed">
          Phase 1 (now): real protocol handshake — the wallet talks to fusion servers and
          reads their live parameters. Phase 2: joining pools and fusing coins.
          Your coins are not being fused yet.
        </p>
      </div>

    </div>
  );
};
