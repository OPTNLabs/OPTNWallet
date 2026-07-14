// One row for a BIP37 full node inside the unified server pool (ServerSettings).
//
// A node speaks the raw BCH P2P protocol, not Electrum, so it lives in the pool
// alongside Fulcrum servers but is used over a different transport — the wallet
// picks the right one automatically by port. This row lets the user Probe a node
// (a real version/verack handshake via bip37_node_probe) to confirm it's
// reachable and serves BIP37, and remove it. Desktop-only (raw TCP).
import React, { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Network } from '../../state/slices/networkSlice';
import { getNodeLabel, parseNodeTarget } from '../../utils/servers/userNodes';

interface NodeProbe {
  user_agent: string;
  protocol_version: number;
  services: number;
  start_height: number;
  serves_bloom: boolean;
}

type ProbeState =
  | { status: 'idle' }
  | { status: 'probing' }
  | { status: 'ok'; probe: NodeProbe }
  | { status: 'fail'; error: string };

export const Bip37NodeRow: React.FC<{
  target: string;
  network: Network;
  onRemove: (target: string) => void;
}> = ({ target, network, onRemove }) => {
  const [state, setState] = useState<ProbeState>({ status: 'idle' });
  const label = getNodeLabel(network, target);

  const probe = async () => {
    const { host, port } = parseNodeTarget(target, network);
    setState({ status: 'probing' });
    try {
      const result = await invoke<NodeProbe>('bip37_node_probe', { host, port, network });
      setState({ status: 'ok', probe: result });
    } catch (err) {
      setState({ status: 'fail', error: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <div className="rounded-xl border border-[var(--wallet-border)] wallet-surface px-3 py-2 text-xs">
      <div className="flex items-center gap-2">
        <span className="rounded-md border border-[var(--wallet-border)] px-1.5 py-0.5 text-[9px] font-semibold wallet-muted uppercase shrink-0">
          Node
        </span>
        <span className="flex-1 break-all font-mono wallet-text-strong">
          {label ? <span className="font-sans">{label} </span> : null}
          <span className={label ? 'opacity-60' : ''}>{target}</span>
        </span>
        <button
          onClick={() => void probe()}
          disabled={state.status === 'probing'}
          className="rounded-lg border border-[var(--wallet-accent)]/40 px-2 py-1 text-[10px] font-semibold text-[var(--wallet-accent)] hover:bg-[var(--wallet-accent)]/5 disabled:opacity-50"
        >
          {state.status === 'probing' ? 'Probing…' : 'Probe'}
        </button>
        <button
          onClick={() => onRemove(target)}
          className="text-[10px] text-red-400/70 hover:text-red-400 px-1 shrink-0"
          aria-label={`Remove ${target}`}
        >
          Remove
        </button>
      </div>

      {state.status === 'ok' && (
        <div className="mt-1.5 space-y-0.5 text-[10px] wallet-muted">
          <p className="font-mono wallet-text-strong break-all">{state.probe.user_agent}</p>
          <p>
            height {state.probe.start_height.toLocaleString()} · protocol {state.probe.protocol_version}
          </p>
          <p className={state.probe.serves_bloom ? 'text-green-400 font-semibold' : 'text-yellow-400/90 font-semibold'}>
            {state.probe.serves_bloom ? 'Serves BIP37 ✓' : 'Does not serve BIP37 ✗ (bloom filtering off)'}
          </p>
        </div>
      )}
      {state.status === 'fail' && (
        <p className="mt-1.5 text-[10px] text-red-400/90 leading-relaxed break-all">{state.error}</p>
      )}
    </div>
  );
};
