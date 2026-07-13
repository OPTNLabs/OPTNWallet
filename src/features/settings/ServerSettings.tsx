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
} from '../../state/slices/preferencesSlice';
import { EXPLORER_PRESETS } from '../../utils/servers/explorers';
import { getUserServers, addUserServer, removeUserServer, isValidServerEntry, getServerLabel } from '../../utils/servers/userServers';
import { CashFusionSettings } from './CashFusionSettings';
import { TorSettings } from './TorSettings';

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
  const currentNetwork = useSelector(selectCurrentNetwork);
  const defaultServers = getElectrumServers(currentNetwork);
  const explorerId = useSelector(selectExplorerId);
  const explorerCustom = useSelector(selectExplorerCustom);
  const [customTx, setCustomTx] = useState(explorerCustom.tx);
  const [customAddr, setCustomAddr] = useState(explorerCustom.address);

  const [autoMode, setAutoMode] = useState(true);
  const [customServer, setCustomServer] = useState('');
  const [currentServer, setCurrentServer] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  const [userServers, setUserServers] = useState<string[]>(() => getUserServers(currentNetwork));
  const [newServer, setNewServer] = useState('');
  const [addError, setAddError] = useState('');

  useEffect(() => {
    setUserServers(getUserServers(currentNetwork));
  }, [currentNetwork]);

  const handleAddUserServer = () => {
    const entry = newServer.trim().replace(/^wss?:\/\//i, '');
    if (!isValidServerEntry(entry)) {
      setAddError('Enter a valid host:port (e.g. 192.168.0.129:50002).');
      return;
    }
    setUserServers(addUserServer(currentNetwork, entry));
    setNewServer('');
    setAddError('');
  };

  const handleRemoveUserServer = (entry: string) => {
    setUserServers(removeUserServer(currentNetwork, entry));
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

        {/* Add your own Electrum/Fulcrum server (host:port or LAN IP) */}
        <div className="flex gap-2 pt-1">
          <input
            type="text"
            value={newServer}
            onChange={(e) => { setNewServer(e.target.value); setAddError(''); }}
            onKeyDown={(e) => { if (e.key === 'Enter') handleAddUserServer(); }}
            placeholder="Add server — host:port, or 192.168.0.129:50002 My Fulcrum"
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

      {/* Tor — directly below the server pool */}
      <TorSettings />

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

      {/* CashFusion (privacy) + Tor — grouped here so this one panel manages
          everything network/server related. */}
      <div className="flex flex-col gap-2 border-t border-[var(--wallet-border)] pt-4">
        <p className="text-xs font-semibold wallet-muted uppercase tracking-wide">CashFusion &amp; Tor</p>
        <CashFusionSettings />
      </div>
    </div>
  );
};
