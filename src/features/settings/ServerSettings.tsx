import React, { useEffect, useState, useCallback } from 'react';
import { useSelector } from 'react-redux';
import { selectCurrentNetwork } from '../../state/selectors/networkSelectors';
import getElectrumAdapter from '../../services/ElectrumAdapter';
import { getElectrumServers } from '../../utils/servers/ElectrumServers';
import { readStorageItem, writeStorageItem, getPreferredStorage } from '../../utils/browserStorage';

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
  const currentNetwork = useSelector(selectCurrentNetwork);
  const defaultServers = getElectrumServers(currentNetwork);

  const [autoMode, setAutoMode] = useState(true);
  const [customServer, setCustomServer] = useState('');
  const [currentServer, setCurrentServer] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

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

      {/* Default server pool */}
      <div className="flex flex-col gap-1.5">
        <p className="text-xs font-semibold wallet-muted uppercase tracking-wide">
          {currentNetwork} server pool
        </p>
        {defaultServers.map((srv) => (
          <button
            key={srv}
            onClick={() => {
              setAutoMode(false);
              setCustomServer(srv);
              setError('');
            }}
            className={`w-full rounded-xl border px-3 py-2 text-left text-xs font-mono transition-colors ${
              currentServer === srv
                ? 'border-[var(--wallet-accent)] text-[var(--wallet-accent)] bg-[var(--wallet-accent)]/10'
                : 'border-[var(--wallet-border)] wallet-muted hover:wallet-text-strong'
            }`}
          >
            <span className="flex items-center justify-between">
              <span>{srv}</span>
              {currentServer === srv && <span className="text-[10px] font-semibold">● active</span>}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
};
