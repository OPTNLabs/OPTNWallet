// CashFusion server configuration and status panel.
// Phase 1: server config + connection probe (UI).
// Phase 2: automated fusion round participation (future — requires TCP protobuf).

import React, { useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import {
  selectCashFusionEnabled,
  selectFusionServer,
  setCashFusionEnabled,
  setFusionServer,
} from '../../state/slices/experimentalSlice';

const KNOWN_SERVERS = [
  { label: 'cashfusion.electroncash.dk (mainnet)', host: 'cashfusion.electroncash.dk:8787' },
  { label: 'fusion.servo.cash (mainnet)', host: 'fusion.servo.cash:8787' },
];

type ConnStatus = 'idle' | 'testing' | 'ok' | 'fail';

// Parse "host:port" into a WebSocket URL for the TCP probe.
// CashFusion servers use TLS on port 8787 → wss://host:8787
function toWssUrl(hostPort: string): string {
  const trimmed = hostPort.trim();
  if (trimmed.startsWith('ws://') || trimmed.startsWith('wss://')) return trimmed;
  const [host, port = '8787'] = trimmed.split(':');
  return `wss://${host}:${port}`;
}

async function probeServer(hostPort: string): Promise<boolean> {
  const url = toWssUrl(hostPort);
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      ws.close();
      resolve(false);
    }, 6000);
    const ws = new WebSocket(url);
    ws.onopen = () => {
      clearTimeout(timeout);
      ws.close();
      resolve(true);
    };
    ws.onerror = () => {
      clearTimeout(timeout);
      resolve(false);
    };
  });
}

export const CashFusionSettings: React.FC = () => {
  const dispatch = useDispatch();
  const enabled = useSelector(selectCashFusionEnabled);
  const savedServer = useSelector(selectFusionServer);

  const [serverInput, setServerInput] = useState(savedServer ?? 'cashfusion.electroncash.dk:8787');
  const [connStatus, setConnStatus] = useState<ConnStatus>('idle');
  const [showProtocolInfo, setShowProtocolInfo] = useState(false);

  const handleSaveServer = () => {
    const trimmed = (serverInput ?? '').trim();
    if (trimmed) dispatch(setFusionServer(trimmed));
  };

  const handleTest = async () => {
    setConnStatus('testing');
    const reachable = await probeServer(serverInput ?? '');
    setConnStatus(reachable ? 'ok' : 'fail');
  };

  const connStatusBadge = () => {
    if (connStatus === 'testing') return <span className="text-[10px] wallet-muted animate-pulse">Probing…</span>;
    if (connStatus === 'ok')   return <span className="text-[10px] text-green-400 font-semibold">Reachable ✓</span>;
    if (connStatus === 'fail') return <span className="text-[10px] text-red-400 font-semibold">Unreachable ✗</span>;
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
              ⚠ Full automatic fusion requires a background service and Tor for optimal privacy.
              The complete protocol (blind signing, Tor, protobuf) is implemented in
              Electron Cash's electroncash_plugins/fusion — that will be the reference
              for our Phase 2 native implementation.
              Manual server configuration and connection testing are available now.
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
            CashFusion is enabled. Configure your server below and test the connection.
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
            disabled={connStatus === 'testing' || !(serverInput ?? '').trim()}
            className="rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface-strong)] px-3 py-1.5 text-xs font-semibold wallet-text-strong disabled:opacity-50 hover:brightness-95 transition-all"
          >
            Test Connection
          </button>
          {connStatusBadge()}
        </div>

        {connStatus === 'fail' && (
          <p className="text-[10px] text-red-400/80 leading-relaxed">
            Could not reach the server. Check the host:port and make sure the server is running.
            Note: this probe tests TCP reachability, not the CashFusion protocol handshake.
          </p>
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
          Phase 1: server config and connection testing.
          Automatic fusion round participation is a planned future feature.
        </p>
      </div>

    </div>
  );
};
