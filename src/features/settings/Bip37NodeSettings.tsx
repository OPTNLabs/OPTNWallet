// BIP37 full-node (SPV) management — Phase 1: add nodes and probe them.
//
// A full node speaks the raw BCH P2P protocol, not Electrum, so this section is
// desktop-only (a WebView can't open a raw TCP peer). Phase 1 is diagnostic:
// add a node (host:port, LAN allowed) and Probe it — the Rust bip37_node_probe
// command completes a real version/verack handshake and reports the peer's
// software, block height, and whether it serves BIP37. Selecting a node as the
// wallet's active backend (and syncing through it) comes in later phases.
import React, { useEffect, useState } from 'react';
import { useSelector } from 'react-redux';
import { invoke } from '@tauri-apps/api/core';
import { selectCurrentNetwork } from '../../state/selectors/networkSelectors';
import { FUSION_SUPPORTED } from '../../services/fusion/FusionStatusService';
import {
  getUserNodes,
  addUserNode,
  removeUserNode,
  getNodeLabel,
  isValidNodeEntry,
  parseNodeTarget,
  defaultNodePort,
} from '../../utils/servers/userNodes';

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

export const Bip37NodeSettings: React.FC = () => {
  const currentNetwork = useSelector(selectCurrentNetwork);
  const [nodes, setNodes] = useState<string[]>(() => getUserNodes(currentNetwork));
  const [newNode, setNewNode] = useState('');
  const [addError, setAddError] = useState('');
  const [probes, setProbes] = useState<Record<string, ProbeState>>({});

  useEffect(() => {
    setNodes(getUserNodes(currentNetwork));
    setProbes({});
  }, [currentNetwork]);

  // Raw TCP peer connections only exist on desktop.
  if (!FUSION_SUPPORTED) return null;

  const handleAdd = () => {
    const entry = newNode.trim();
    if (!isValidNodeEntry(entry)) {
      setAddError(`Enter host:port (e.g. 192.168.0.129:${defaultNodePort(currentNetwork)}).`);
      return;
    }
    setNodes(addUserNode(currentNetwork, entry));
    setNewNode('');
    setAddError('');
  };

  const handleRemove = (target: string) => {
    setNodes(removeUserNode(currentNetwork, target));
    setProbes((p) => {
      const next = { ...p };
      delete next[target];
      return next;
    });
  };

  const handleProbe = async (target: string) => {
    const { host, port } = parseNodeTarget(target, currentNetwork);
    setProbes((p) => ({ ...p, [target]: { status: 'probing' } }));
    try {
      const probe = await invoke<NodeProbe>('bip37_node_probe', {
        host,
        port,
        network: currentNetwork,
      });
      setProbes((p) => ({ ...p, [target]: { status: 'ok', probe } }));
    } catch (err) {
      setProbes((p) => ({
        ...p,
        [target]: { status: 'fail', error: err instanceof Error ? err.message : String(err) },
      }));
    }
  };

  return (
    <div className="flex flex-col gap-2 border-t border-[var(--wallet-border)] pt-4">
      <div>
        <p className="text-xs font-semibold wallet-muted uppercase tracking-wide">
          BIP37 nodes (SPV) · experimental
        </p>
        <p className="text-[10px] wallet-muted leading-relaxed">
          Query a full node directly over the BCH P2P protocol instead of a Fulcrum server
          (like Flowee Pay). Add a node — including your own LAN node — and Probe it to check it's
          reachable and serves BIP37. Syncing the wallet through a node comes in a later update.
        </p>
      </div>

      {nodes.length === 0 && (
        <p className="text-[10px] wallet-muted italic">No nodes added yet.</p>
      )}

      {nodes.map((target) => {
        const label = getNodeLabel(currentNetwork, target);
        const state = probes[target] ?? { status: 'idle' as const };
        return (
          <div
            key={target}
            className="rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] px-3 py-2 text-xs"
          >
            <div className="flex items-center gap-2">
              <span className="flex-1 break-all font-mono wallet-text-strong">
                {label ? <span className="font-sans">{label} </span> : null}
                <span className={label ? 'opacity-60' : ''}>{target}</span>
              </span>
              <button
                onClick={() => void handleProbe(target)}
                disabled={state.status === 'probing'}
                className="rounded-lg border border-[var(--wallet-accent)]/40 px-2 py-1 text-[10px] font-semibold text-[var(--wallet-accent)] hover:bg-[var(--wallet-accent)]/5 disabled:opacity-50"
              >
                {state.status === 'probing' ? 'Probing…' : 'Probe'}
              </button>
              <button
                onClick={() => handleRemove(target)}
                className="text-[10px] text-red-400/70 hover:text-red-400 px-1"
                aria-label={`Remove ${target}`}
              >
                Remove
              </button>
            </div>

            {state.status === 'ok' && (
              <div className="mt-1.5 space-y-0.5 text-[10px] wallet-muted">
                <p className="font-mono wallet-text-strong break-all">{state.probe.user_agent}</p>
                <p>
                  height {state.probe.start_height.toLocaleString()} · protocol{' '}
                  {state.probe.protocol_version}
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
      })}

      <div className="flex gap-2 pt-1">
        <input
          type="text"
          value={newNode}
          onChange={(e) => { setNewNode(e.target.value); setAddError(''); }}
          onKeyDown={(e) => { if (e.key === 'Enter') handleAdd(); }}
          placeholder={`Add node — host:${defaultNodePort(currentNetwork)}, or 192.168.0.129:${defaultNodePort(currentNetwork)} My Node`}
          className="flex-1 rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] px-3 py-2 text-xs font-mono wallet-text-strong placeholder:wallet-muted outline-none focus:ring-1 focus:ring-[var(--wallet-accent)]"
        />
        <button
          onClick={handleAdd}
          disabled={!newNode.trim()}
          className="rounded-xl border border-[var(--wallet-accent)]/40 px-3 py-2 text-xs font-semibold text-[var(--wallet-accent)] hover:bg-[var(--wallet-accent)]/5 disabled:opacity-40 transition-colors"
        >
          Add
        </button>
      </div>
      {addError && <p className="text-[10px] text-red-400">{addError}</p>}
    </div>
  );
};
