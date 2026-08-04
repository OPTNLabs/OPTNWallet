// Desktop-only developer console: Electrum RPC + live log stream.
// Shows recent log entries and lets you send raw Electrum JSON-RPC calls.

import React, { useEffect, useRef, useState, useCallback } from 'react';
import getElectrumAdapter from '../../services/ElectrumAdapter';
import { useI18n } from '../../i18n/useI18n';

type LogLevel = 'log' | 'info' | 'warn' | 'error';

type LogEntry = {
  id: number;
  ts: string;
  level: LogLevel;
  text: string;
};

type RpcEntry = {
  id: number;
  direction: 'sent' | 'received' | 'error';
  text: string;
};

let _logId = 0;
const globalLogs: LogEntry[] = [];
const logListeners = new Set<() => void>();

function installLogInterceptor() {
  if ((window as unknown as Record<string, unknown>).__optn_console_installed)
    return;
  (window as unknown as Record<string, unknown>).__optn_console_installed =
    true;

  (['log', 'info', 'warn', 'error'] as LogLevel[]).forEach((level) => {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      orig(...args);
      const text = args
        .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
        .join(' ');
      const now = new Date();
      const ts = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
      globalLogs.push({ id: _logId++, ts, level, text });
      if (globalLogs.length > 500)
        globalLogs.splice(0, globalLogs.length - 500);
      logListeners.forEach((fn) => fn());
    };
  });
}

installLogInterceptor();

const levelColor: Record<LogLevel, string> = {
  log: 'wallet-muted',
  info: 'text-blue-400',
  warn: 'text-yellow-400',
  error: 'text-red-400',
};

export const ConsolePanel: React.FC = () => {
  const { t } = useI18n();
  const [logs, setLogs] = useState<LogEntry[]>([...globalLogs]);
  const [rpcHistory, setRpcHistory] = useState<RpcEntry[]>([]);
  const [rpcInput, setRpcInput] = useState('');
  const [sending, setSending] = useState(false);
  const [tab, setTab] = useState<'log' | 'rpc'>('log');
  const [filterLevel, setFilterLevel] = useState<LogLevel | 'all'>('all');
  const logEndRef = useRef<HTMLDivElement>(null);
  const rpcEndRef = useRef<HTMLDivElement>(null);

  // Live log stream
  useEffect(() => {
    const cb = () => setLogs([...globalLogs]);
    logListeners.add(cb);
    return () => {
      logListeners.delete(cb);
    };
  }, []);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  useEffect(() => {
    rpcEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [rpcHistory]);

  // Parse "method param1 param2 ..." — params can be JSON values
  const parseRpcInput = (
    raw: string
  ): { method: string; params: unknown[] } => {
    const parts = raw.trim().split(/\s+/);
    const method = parts[0];
    const params = parts.slice(1).map((p) => {
      try {
        return JSON.parse(p);
      } catch {
        return p;
      }
    });
    return { method, params };
  };

  const handleSendRpc = useCallback(async () => {
    const raw = rpcInput.trim();
    if (!raw || sending) return;
    setSending(true);
    const { method, params } = parseRpcInput(raw);
    const sentId = _logId++;
    setRpcHistory((h) => [
      ...h,
      {
        id: sentId,
        direction: 'sent',
        text: `→ ${method}(${params.map((p) => JSON.stringify(p)).join(', ')})`,
      },
    ]);
    try {
      const adapter = getElectrumAdapter();
      const result = await adapter.request(method, ...params);
      setRpcHistory((h) => [
        ...h,
        {
          id: _logId++,
          direction: 'received',
          text: JSON.stringify(result, null, 2),
        },
      ]);
    } catch (err) {
      setRpcHistory((h) => [
        ...h,
        { id: _logId++, direction: 'error', text: String(err) },
      ]);
    } finally {
      setSending(false);
    }
  }, [rpcInput, sending]);

  const filteredLogs =
    filterLevel === 'all' ? logs : logs.filter((l) => l.level === filterLevel);

  return (
    <div className="flex flex-col gap-3 h-full min-h-0">
      {/* Tab bar */}
      <div className="flex gap-2">
        {(['log', 'rpc'] as const).map((tabName) => (
          <button
            key={tabName}
            onClick={() => setTab(tabName)}
            className={`flex-1 rounded-xl border py-1.5 text-xs font-semibold uppercase tracking-wide transition-colors ${
              tab === tabName
                ? 'border-[var(--wallet-accent)] text-[var(--wallet-accent)] bg-[var(--wallet-accent)]/10'
                : 'border-[var(--wallet-border)] wallet-muted'
            }`}
          >
            {tabName === 'log' ? t('console.appLog') : t('console.rpc')}
          </button>
        ))}
      </div>

      {tab === 'log' && (
        <>
          {/* Level filter */}
          <div className="flex gap-1.5">
            {(['all', 'log', 'info', 'warn', 'error'] as const).map((lvl) => (
              <button
                key={lvl}
                onClick={() => setFilterLevel(lvl)}
                className={`rounded-lg border px-2 py-0.5 text-[10px] font-semibold capitalize transition-colors ${
                  filterLevel === lvl
                    ? 'border-[var(--wallet-accent)] text-[var(--wallet-accent)]'
                    : 'border-[var(--wallet-border)] wallet-muted'
                }`}
              >
                {lvl}
              </button>
            ))}
            <button
              onClick={() => {
                globalLogs.length = 0;
                setLogs([]);
              }}
              className="ml-auto rounded-lg border border-[var(--wallet-border)] px-2 py-0.5 text-[10px] wallet-muted hover:text-red-400"
            >
              {t('console.clear')}
            </button>
          </div>

          {/* Log output */}
          <div className="flex-1 min-h-0 overflow-y-auto rounded-xl border border-[var(--wallet-border)] bg-black/30 p-3 font-mono text-[11px] leading-relaxed space-y-0.5">
            {filteredLogs.length === 0 && (
              <p className="wallet-muted italic">{t('console.noEntries')}</p>
            )}
            {filteredLogs.map((entry) => (
              <div key={entry.id} className="flex gap-2">
                <span className="wallet-muted shrink-0">{entry.ts}</span>
                <span
                  className={`shrink-0 uppercase text-[9px] font-bold w-8 ${levelColor[entry.level]}`}
                >
                  {entry.level}
                </span>
                <span className="wallet-text-strong break-all">
                  {entry.text}
                </span>
              </div>
            ))}
            <div ref={logEndRef} />
          </div>
        </>
      )}

      {tab === 'rpc' && (
        <>
          {/* RPC output */}
          <div className="flex-1 min-h-0 overflow-y-auto rounded-xl border border-[var(--wallet-border)] bg-black/30 p-3 font-mono text-[11px] leading-relaxed space-y-1">
            <p className="wallet-muted text-[10px] mb-2">
              {t('console.typeHint')}
            </p>
            {rpcHistory.map((entry) => (
              <div
                key={entry.id}
                className={`whitespace-pre-wrap break-all ${
                  entry.direction === 'sent'
                    ? 'text-blue-400'
                    : entry.direction === 'error'
                      ? 'text-red-400'
                      : 'text-green-400'
                }`}
              >
                {entry.text}
              </div>
            ))}
            <div ref={rpcEndRef} />
          </div>

          {/* RPC input */}
          <div className="flex gap-2">
            <input
              type="text"
              value={rpcInput}
              onChange={(e) => setRpcInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleSendRpc();
              }}
              placeholder={t('console.placeholder')}
              className="flex-1 rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] px-3 py-2 text-xs font-mono wallet-text-strong placeholder:wallet-muted outline-none focus:ring-1 focus:ring-[var(--wallet-accent)]"
              disabled={sending}
            />
            <button
              onClick={() => void handleSendRpc()}
              disabled={sending || !rpcInput.trim()}
              className="rounded-xl px-4 py-2 text-xs font-semibold text-white disabled:opacity-50"
              style={{ background: 'var(--wallet-accent, #6366f1)' }}
            >
              {sending ? t('console.sending') : t('console.send')}
            </button>
          </div>
        </>
      )}
    </div>
  );
};
