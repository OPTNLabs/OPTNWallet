import React, { useEffect, useState, useCallback } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { selectCurrentNetwork } from '../../state/selectors/networkSelectors';
import getElectrumAdapter from '../../services/ElectrumAdapter';
import { getElectrumServers } from '../../utils/servers/ElectrumServers';
import { readStorageItem, writeStorageItem, getPreferredStorage } from '../../utils/browserStorage';
import {
  selectExplorerId,
  selectExplorerCustom,
  setExplorerId,
  setExplorerCustom,
  selectFeeMode,
  selectCustomFeeSatPerByte,
  setFeeMode,
  setCustomFeeSatPerByte,
} from '../../state/slices/preferencesSlice';
import { EXPLORER_PRESETS } from '../../utils/servers/explorers';
import { getUserServers, addUserServer, removeUserServer, isValidServerEntry, getServerLabel, parseServerEntry } from '../../utils/servers/userServers';
import { getUserNodes, addUserNode, removeUserNode } from '../../utils/servers/userNodes';
import { Bip37NodeRow } from './Bip37NodeSettings';
import { ServerPrivacySettings } from './ServerPrivacySettings';
import {
  getBackend,
  setBackend,
  BACKEND_CHANGED_EVENT,
  type Backend,
} from '../../platform/desktop/backendSelection';
import { isDesktopPlatform } from '../../utils/platform';

// BCH P2P default ports across networks — an entry on one of these is a BIP37
// full node, anything else is an Electrum/Fulcrum server. Lets one "Add server"
// field accept both, routed to the right transport automatically.
const P2P_NODE_PORTS = new Set([8333, 48333, 18333, 28333, 38333, 18444]);

const USER_SERVER_KEY = 'optn.electrum.user-server';
const LAST_HEALTHY_KEY = 'optn.electrum.last-healthy-server';

function readUserServer(): string {
  return readStorageItem(getPreferredStorage(), USER_SERVER_KEY) ?? '';
}

function saveUserServer(value: string): void {
  writeStorageItem(getPreferredStorage(), USER_SERVER_KEY, value);
}

function readLastHealthy(): string {
  return readStorageItem(getPreferredStorage(), LAST_HEALTHY_KEY) ?? '';
}

export const ServerSettings: React.FC = () => {
  const dispatch = useDispatch();
  const desktop = isDesktopPlatform();
  const currentNetwork = useSelector(selectCurrentNetwork);
  const defaultServers = getElectrumServers(currentNetwork);
  const explorerId = useSelector(selectExplorerId);
  const explorerCustom = useSelector(selectExplorerCustom);
  const feeMode = useSelector(selectFeeMode);
  const customFeeSatPerByte = useSelector(selectCustomFeeSatPerByte);
  const [customTx, setCustomTx] = useState(explorerCustom.tx);
  const [customAddr, setCustomAddr] = useState(explorerCustom.address);

  const [autoMode, setAutoMode] = useState(true);
  const [customServer, setCustomServer] = useState('');
  const [currentServer, setCurrentServer] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  const [userServers, setUserServers] = useState<string[]>(() => getUserServers(currentNetwork));
  const [nodes, setNodes] = useState<string[]>(() => getUserNodes(currentNetwork));
  const [newServer, setNewServer] = useState('');
  const [addError, setAddError] = useState('');

  useEffect(() => {
    setUserServers(getUserServers(currentNetwork));
    setNodes(getUserNodes(currentNetwork));
  }, [currentNetwork]);

  // Exactly ONE backend serves the wallet: the pool (auto/failover), a pinned
  // Electrum server, or a pinned BIP37 node. Reflect changes from the node rows.
  const [backend, setBackendState] = useState<Backend>(() => getBackend(currentNetwork));
  useEffect(() => {
    const refresh = () => setBackendState(getBackend(currentNetwork));
    refresh();
    window.addEventListener(BACKEND_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(BACKEND_CHANGED_EVENT, refresh);
  }, [currentNetwork]);

  useEffect(() => {
    if (!desktop && backend.kind === 'node') {
      setBackend(currentNetwork, { kind: 'auto' });
    }
  }, [backend, currentNetwork, desktop]);

  const displayedBackend =
    !desktop && backend.kind === 'node' ? { kind: 'auto' as const } : backend;

  const handleAddUserServer = () => {
    const entry = newServer.trim().replace(/^wss?:\/\//i, '');
    if (!isValidServerEntry(entry)) {
      setAddError('Enter a valid host:port (e.g. 192.168.0.129:50002).');
      return;
    }
    // Auto-detect the transport by port: a BCH P2P port means a BIP37 full node,
    // anything else is an Electrum/Fulcrum server. Both land in the one pool and
    // the wallet uses each over the right protocol automatically.
    const port = Number(parseServerEntry(entry).target.split(':')[1]);
    if (P2P_NODE_PORTS.has(port)) {
      if (!desktop) {
        setAddError(
          'Raw BCH node connections are only available on desktop. Add an Electrum/Fulcrum WSS server instead.'
        );
        return;
      }
      setNodes(addUserNode(currentNetwork, entry));
    } else {
      setUserServers(addUserServer(currentNetwork, entry));
    }
    setNewServer('');
    setAddError('');
  };

  const handleRemoveUserServer = (entry: string) => {
    setUserServers(removeUserServer(currentNetwork, entry));
  };

  const handleRemoveNode = (target: string) => {
    setNodes(removeUserNode(currentNetwork, target));
  };

  // Refresh current server state
  const refreshCurrent = useCallback(() => {
    const adapter = getElectrumAdapter();
    setCurrentServer(adapter.getCurrentServer() ?? readLastHealthy() ?? null);
  }, []);

  useEffect(() => {
    const saved = readUserServer();
    if (saved) {
      setCustomServer(saved);
      setAutoMode(false);
    }
    refreshCurrent();
  }, [refreshCurrent]);

  const handleConnect = async () => {
    setConnecting(true);
    setError('');
    setStatus('');
    const adapter = getElectrumAdapter();
    try {
      const target = autoMode ? undefined : customServer.trim() || undefined;
      if (!autoMode && customServer.trim()) {
        saveUserServer(customServer.trim());
      } else {
        saveUserServer('');
      }
      await adapter.reconnect(target);
      refreshCurrent();
      setStatus('Connected.');
      setTimeout(() => setStatus(''), 3000);
    } catch (err) {
      setError(`Connection failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setConnecting(false);
    }
  };

  const handleAutoToggle = (auto: boolean) => {
    setAutoMode(auto);
    setError('');
    if (auto) {
      setCustomServer('');
      saveUserServer('');
    }
  };

  // Connect directly to a server from the pool list (one click, no separate
  // Connect button needed).
  const connectToServer = async (server: string) => {
    setAutoMode(false);
    setCustomServer(server);
    setConnecting(true);
    setError('');
    setStatus('');
    try {
      saveUserServer(server);
      await getElectrumAdapter().reconnect(server);
      refreshCurrent();
      setStatus('Connected.');
      setTimeout(() => setStatus(''), 3000);
    } catch (err) {
      setError(`Connection failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setConnecting(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">

      {/* Which single backend serves this wallet */}
      <div className="rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] p-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold wallet-muted uppercase tracking-wide">Backend</p>
          <p className="text-sm wallet-text-strong break-all">
            {displayedBackend.kind === 'auto' ? (
              'Auto — server pool, with failover'
            ) : displayedBackend.kind === 'node' ? (
              <>
                Node <span className="font-mono opacity-70">{displayedBackend.target}</span>{' '}
                <span className="text-[10px] text-[var(--wallet-accent)] font-semibold">trustless</span>
              </>
            ) : (
              <>
                Server <span className="font-mono opacity-70">{displayedBackend.target}</span>
              </>
            )}
          </p>
          <p className="text-[10px] wallet-muted">
            Only this backend is used — pinning a node means Electrum servers aren&apos;t consulted.
          </p>
        </div>
        {backend.kind !== 'auto' && (
          <button
            onClick={() => setBackend(currentNetwork, { kind: 'auto' })}
            className="shrink-0 rounded-lg border border-[var(--wallet-border)] px-2.5 py-1 text-[10px] font-semibold wallet-text-strong hover:border-[var(--wallet-accent)]/60"
          >
            Use Auto
          </button>
        )}
      </div>

      {/* Current connection */}
      <div className="rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] p-3 space-y-1">
        <p className="text-xs font-semibold wallet-muted uppercase tracking-wide">Connected server</p>
        <p className="text-sm font-mono wallet-text-strong break-all">
          {currentServer ?? <span className="wallet-muted italic">Not connected</span>}
        </p>
      </div>

      {/* Auto / Manual toggle */}
      <div className="flex gap-2">
        <button
          onClick={() => handleAutoToggle(true)}
          className={`flex-1 rounded-xl border py-2 text-sm font-semibold transition-colors ${
            autoMode
              ? 'border-[var(--wallet-accent)] text-[var(--wallet-accent)] bg-[var(--wallet-accent)]/10'
              : 'border-[var(--wallet-border)] wallet-muted'
          }`}
        >
          Auto
        </button>
        <button
          onClick={() => handleAutoToggle(false)}
          className={`flex-1 rounded-xl border py-2 text-sm font-semibold transition-colors ${
            !autoMode
              ? 'border-[var(--wallet-accent)] text-[var(--wallet-accent)] bg-[var(--wallet-accent)]/10'
              : 'border-[var(--wallet-border)] wallet-muted'
          }`}
        >
          Manual
        </button>
      </div>

      {/* Manual server input */}
      {!autoMode && (
        <div className="flex flex-col gap-2">
          <input
            type="text"
            value={customServer}
            onChange={(e) => { setCustomServer(e.target.value); setError(''); }}
            placeholder="host, host:50004, or wss://host:50004"
            className="w-full rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] px-3 py-2 text-sm font-mono wallet-text-strong placeholder:wallet-muted outline-none focus:ring-1 focus:ring-[var(--wallet-accent)]"
            onKeyDown={(e) => { if (e.key === 'Enter') void handleConnect(); }}
          />
          <p className="text-xs wallet-muted">
            Default port: 50004 (WSS). Use <span className="font-mono">wss://</span> prefix to force WSS,
            or <span className="font-mono">ws://</span> for unencrypted.
          </p>
        </div>
      )}

      {error && <p className="text-xs text-red-400">{error}</p>}
      {status && <p className="text-xs text-green-400">{status}</p>}

      <button
        onClick={() => void handleConnect()}
        disabled={connecting || (!autoMode && !customServer.trim())}
        className="w-full rounded-xl py-2.5 text-sm font-semibold text-white disabled:opacity-50"
        style={{ background: 'var(--wallet-accent, #6366f1)' }}
      >
        {connecting ? 'Connecting…' : 'Connect'}
      </button>

      {/* Server pool — seed servers + your own, in one list. Click a row to
          connect to it; your own servers can also be removed. */}
      <div className="flex flex-col gap-1.5">
        <p className="text-xs font-semibold wallet-muted uppercase tracking-wide">
          {currentNetwork} server pool
        </p>
        {defaultServers.map((srv) => {
          const isMine = userServers.includes(srv);
          const label = isMine ? getServerLabel(currentNetwork, srv) : undefined;
          return (
            <div
              key={srv}
              className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-mono transition-colors ${
                currentServer === srv
                  ? 'border-[var(--wallet-accent)] text-[var(--wallet-accent)] bg-[var(--wallet-accent)]/10'
                  : 'border-[var(--wallet-border)] wallet-muted hover:wallet-text-strong'
              }`}
            >
              <button
                onClick={() => void connectToServer(srv)}
                disabled={connecting}
                className="flex-1 text-left disabled:opacity-60"
                title="Connect to this server"
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="break-all">
                    {label ? <span className="font-sans">{label}</span> : srv}
                    {label && <span className="ml-1.5 opacity-50">{srv}</span>}
                  </span>
                  {currentServer === srv && <span className="text-[10px] font-semibold whitespace-nowrap">● active</span>}
                </span>
              </button>
              {isMine && (
                <button
                  onClick={() => handleRemoveUserServer(srv)}
                  className="text-[10px] text-red-400/70 hover:text-red-400 px-1 shrink-0"
                  aria-label={`Remove ${srv}`}
                >
                  Remove
                </button>
              )}
            </div>
          );
        })}

        {/* BIP37 full nodes live in the SAME pool (different transport, chosen
            automatically by port). Desktop-only; Bip37NodeRow returns nothing on
            the web build. */}
        {desktop && nodes.map((target) => (
          <Bip37NodeRow
            key={`node:${target}`}
            target={target}
            network={currentNetwork}
            onRemove={handleRemoveNode}
          />
        ))}

        {/* Add an Electrum/Fulcrum server OR a BIP37 node (LAN allowed). The
            port decides which transport the wallet uses. */}
        <div className="flex gap-2 pt-1">
          <input
            type="text"
            value={newServer}
            onChange={(e) => { setNewServer(e.target.value); setAddError(''); }}
            onKeyDown={(e) => { if (e.key === 'Enter') handleAddUserServer(); }}
            placeholder={
              desktop
                ? 'Add server — Fulcrum host:50002, or a node host:8333'
                : 'Add WSS server — host:50004'
            }
            className="flex-1 rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] px-3 py-2 text-xs font-mono wallet-text-strong placeholder:wallet-muted outline-none focus:ring-1 focus:ring-[var(--wallet-accent)]"
          />
          <button
            onClick={handleAddUserServer}
            disabled={!newServer.trim()}
            className="rounded-xl border border-[var(--wallet-accent)]/40 px-3 py-2 text-xs font-semibold text-[var(--wallet-accent)] hover:bg-[var(--wallet-accent)]/5 disabled:opacity-40 transition-colors"
          >
            Add
          </button>
        </div>
        {addError && <p className="text-[10px] text-red-400">{addError}</p>}
      </div>

      {/* Block explorer */}
      <div className="flex flex-col gap-2 border-t border-[var(--wallet-border)] pt-4">
        <p className="text-xs font-semibold wallet-muted uppercase tracking-wide">Block explorer</p>
        <p className="text-xs wallet-muted">Used for “open in explorer” links on transactions.</p>
        <select
          value={explorerId}
          onChange={(e) => dispatch(setExplorerId(e.target.value))}
          className="w-full rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] px-3 py-2 text-sm wallet-text-strong outline-none focus:ring-1 focus:ring-[var(--wallet-accent)]"
        >
          {EXPLORER_PRESETS.map((e) => (
            <option key={e.id} value={e.id}>{e.label}</option>
          ))}
          <option value="custom">Custom…</option>
        </select>

        {explorerId === 'custom' && (
          <div className="flex flex-col gap-2">
            <input
              type="text"
              value={customTx}
              onChange={(e) => setCustomTx(e.target.value)}
              placeholder="Tx URL, e.g. https://example.com/tx/{txid}"
              className="w-full rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] px-3 py-2 text-xs font-mono wallet-text-strong placeholder:wallet-muted outline-none focus:ring-1 focus:ring-[var(--wallet-accent)]"
            />
            <input
              type="text"
              value={customAddr}
              onChange={(e) => setCustomAddr(e.target.value)}
              placeholder="Address URL, e.g. https://example.com/address/{address}"
              className="w-full rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] px-3 py-2 text-xs font-mono wallet-text-strong placeholder:wallet-muted outline-none focus:ring-1 focus:ring-[var(--wallet-accent)]"
            />
            <p className="text-[10px] wallet-muted">
              Use <span className="font-mono">{'{txid}'}</span> and <span className="font-mono">{'{address}'}</span> as placeholders.
            </p>
            <button
              onClick={() => dispatch(setExplorerCustom({ tx: customTx, address: customAddr }))}
              disabled={!customTx.includes('{txid}')}
              className="self-start rounded-xl border border-[var(--wallet-accent)]/40 px-3 py-1.5 text-xs font-semibold text-[var(--wallet-accent)] hover:bg-[var(--wallet-accent)]/5 disabled:opacity-40 transition-colors"
            >
              Save custom explorer
            </button>
          </div>
        )}
      </div>

      {/* Transaction fee */}
      <div className="flex flex-col gap-2 border-t border-[var(--wallet-border)] pt-4">
        <p className="text-xs font-semibold wallet-muted uppercase tracking-wide">Transaction fee</p>
        <p className="text-xs wallet-muted">
          Fee rate for new transactions. Automatic uses the network minimum (~1 sat/byte, Electron Cash default).
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => dispatch(setFeeMode('auto'))}
            className={`flex-1 rounded-xl border px-3 py-2 text-sm font-semibold transition-colors ${
              feeMode === 'auto'
                ? 'border-[var(--wallet-accent)] text-[var(--wallet-accent)] bg-[var(--wallet-accent)]/10'
                : 'border-[var(--wallet-border)] wallet-muted'
            }`}
          >
            Automatic
          </button>
          <button
            type="button"
            onClick={() => dispatch(setFeeMode('custom'))}
            className={`flex-1 rounded-xl border px-3 py-2 text-sm font-semibold transition-colors ${
              feeMode === 'custom'
                ? 'border-[var(--wallet-accent)] text-[var(--wallet-accent)] bg-[var(--wallet-accent)]/10'
                : 'border-[var(--wallet-border)] wallet-muted'
            }`}
          >
            Custom
          </button>
        </div>
        {feeMode === 'custom' && (
          <label className="flex items-center gap-2 text-sm wallet-text-strong">
            <input
              type="number"
              min={1}
              step={0.1}
              value={customFeeSatPerByte}
              onChange={(e) => dispatch(setCustomFeeSatPerByte(Number(e.target.value)))}
              className="w-28 rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] px-3 py-2 text-sm wallet-text-strong outline-none focus:ring-1 focus:ring-[var(--wallet-accent)]"
            />
            <span className="text-xs wallet-muted">sat/byte — applies to your next transaction</span>
          </label>
        )}
      </div>

      {desktop && <ServerPrivacySettings />}
    </div>
  );
};
