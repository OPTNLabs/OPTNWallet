import { useCallback, useEffect, useState } from 'react';
import SectionCard from '../../components/ui/SectionCard';
import {
  addChainSource,
  CHAIN_POLICY_DESCRIPTIONS,
  CHAIN_POLICY_LABELS,
  DEFAULT_PORTS,
  ENDPOINT_KINDS,
  readChainSources,
  rebuildChainRoutes,
  removeChainSource,
  SELECTABLE_CHAIN_POLICIES,
  setChainPolicy,
  setChainSourceDisposition,
  type ChainSource,
  type ChainSourcesView,
} from '../../platform/desktop/chainSourcesBridge';
import {
  integratedTorStatus,
  startIntegratedTor,
} from '../../platform/desktop/FusionStatusService';
import {
  readEngineWalletSync,
  refreshEngineWallet,
  type EngineWalletSync,
} from '../../platform/desktop/engineWalletBridge';
import { SATSINBITCOIN } from '../../utils/constants';
import { refusedForWantOfTor } from './chainSourceStatus';

/**
 * Every chain source for the active network, as the Rust runtime sees them.
 *
 * The rest of this screen still edits the single Electrum server and single
 * peer the legacy settings shape can hold. This section shows the model those
 * fields are a narrow view of: bootstrap and user sources together, what each
 * one is allowed to answer, and which of them the current policy actually
 * selected — including when the answer is "none, and here is why".
 */
function statusLine(source: ChainSource): { text: string; tone: string } {
  if (source.disposition === 'banned') {
    return { text: 'Banned', tone: 'text-red-400' };
  }
  if (source.disposition === 'disabled') {
    return { text: 'Disabled', tone: 'wallet-muted' };
  }
  if (source.live_protocols.length > 0) {
    return {
      text: `Connected · ${source.live_protocols.join(', ')}`,
      tone: 'text-[var(--wallet-accent)]',
    };
  }
  if (source.failures.length > 0) {
    return { text: source.failures[0].error, tone: 'text-amber-400' };
  }
  if (source.role) {
    return { text: 'Selected · not connected', tone: 'text-amber-400' };
  }
  return { text: 'Not selected by the current policy', tone: 'wallet-muted' };
}

export function ChainSourcesSettings() {
  const [view, setView] = useState<ChainSourcesView | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [host, setHost] = useState('');
  const [label, setLabel] = useState('');
  const [kind, setKind] = useState(ENDPOINT_KINDS[0].value);
  const [ownInfrastructure, setOwnInfrastructure] = useState(false);
  const [engineSync, setEngineSync] = useState<EngineWalletSync | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [torStarting, setTorStarting] = useState(false);
  const [torProgress, setTorProgress] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      setView(await readChainSources());
      setEngineSync(await readEngineWalletSync());
      setError('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }, []);

  useEffect(() => {
    void refresh();
    // The runtime rebuilds routes when the saved policy changes, so a probe
    // result can arrive a moment after the edit that caused it.
    const timer = setInterval(() => void refresh(), 4000);
    return () => clearInterval(timer);
  }, [refresh]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await action();
      await refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  const submitSource = () => {
    const entry = host.trim();
    if (!entry) {
      setError('Enter a host or IP address.');
      return;
    }
    const [hostPart, portPart] = entry.split(':');
    const port = portPart ? Number(portPart) : DEFAULT_PORTS[kind];
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      setError('That port is not valid.');
      return;
    }
    void run(async () => {
      await addChainSource({
        label: label.trim() || hostPart,
        kind,
        host: hostPart,
        port,
        infrastructureGroup: ownInfrastructure ? 'mine' : null,
      });
      setHost('');
      setLabel('');
      setOwnInfrastructure(false);
      setShowAdd(false);
    });
  };

  if (!view) {
    return (
      <SectionCard className="p-4">
        <p className="text-sm wallet-muted">
          {error || 'Reading chain sources…'}
        </p>
      </SectionCard>
    );
  }

  return (
    <SectionCard className="p-4 space-y-4">
      <div>
        <p className="text-sm font-semibold wallet-text-strong">
          Chain sources
        </p>
        <p className="mt-1 text-xs wallet-muted">
          {view.network} · {view.wallet_routes} route
          {view.wallet_routes === 1 ? '' : 's'} able to sync right now
          {view.verified_tip
            ? ` · verified header ${view.verified_tip.height}`
            : ' · no verified headers yet'}
        </p>
      </div>

      {refusedForWantOfTor(view.sources) && (
        <div className="rounded-lg border border-[var(--wallet-warning-border)] bg-[var(--wallet-warning-bg)] px-3 py-2 text-xs text-[var(--wallet-warning-text)]">
          <p>
            Public sources are reached through Tor, and no verified proxy is
            running. A source you mark as your own is dialled directly instead.
          </p>
          <button
            type="button"
            disabled={torStarting}
            data-testid="start-tor-for-chain"
            className="wallet-btn-secondary mt-2 px-3 py-1.5 text-xs"
            onClick={() => {
              setTorStarting(true);
              setTorProgress(0);
              // Bootstrap can take a minute on a slow or filtered network, so
              // report progress rather than leaving a dead button. The routes
              // rebuild on their own once the proxy verifies.
              const poll = setInterval(() => {
                void integratedTorStatus()
                  .then((status) => setTorProgress(status.bootstrap_percent))
                  .catch(() => undefined);
              }, 1500);
              void startIntegratedTor()
                // The proxy exists now; the stack still holds routes built
                // when it did not, so ask for a rebuild before reading back.
                .then(() => rebuildChainRoutes())
                .then(() => refresh())
                .catch((failure) =>
                  setError(
                    failure instanceof Error ? failure.message : String(failure)
                  )
                )
                .finally(() => {
                  clearInterval(poll);
                  setTorStarting(false);
                  setTorProgress(null);
                });
            }}
          >
            {torStarting
              ? `Starting Tor… ${torProgress ?? 0}%`
              : 'Start Tor for chain routes'}
          </button>
        </div>
      )}

      {view.configuration_error && (
        <p className="rounded-lg border border-[var(--wallet-danger-border)] bg-[var(--wallet-danger-bg)] px-3 py-2 text-xs text-[var(--wallet-danger-text)]">
          {view.configuration_error}
        </p>
      )}

      <div>
        <label
          className="block text-xs font-semibold wallet-text-strong"
          htmlFor="chain-policy"
        >
          Connection policy
        </label>
        <select
          id="chain-policy"
          className="wallet-input mt-1.5 w-full rounded-md px-3 py-2 text-sm wallet-text-strong"
          value={view.policy}
          disabled={busy}
          onChange={(event) => {
            const next = event.target.value;
            // "Custom" describes a saved policy this list cannot name. Offering
            // it as a choice would overwrite that policy with a guess.
            if (next === 'custom') return;
            void run(() =>
              setChainPolicy(next as Exclude<typeof view.policy, 'custom'>)
            );
          }}
        >
          {view.policy === 'custom' && (
            <option value="custom">{CHAIN_POLICY_LABELS.custom}</option>
          )}
          {SELECTABLE_CHAIN_POLICIES.map((policy) => (
            <option key={policy} value={policy}>
              {CHAIN_POLICY_LABELS[policy]}
            </option>
          ))}
        </select>
        <p className="mt-1 text-[11px] wallet-muted">
          {CHAIN_POLICY_DESCRIPTIONS[view.policy]}
          {view.protocols.length > 0 ? ` · ${view.protocols.join(', ')}` : ''}
        </p>
      </div>

      {engineSync && (
        <div className="rounded-xl border border-[var(--wallet-border)] wallet-surface-strong p-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs font-semibold wallet-text-strong">
              Shared engine sync
            </p>
            <button
              type="button"
              disabled={syncing || engineSync.refreshing}
              data-testid="engine-refresh-wallet"
              className="wallet-btn-secondary px-2.5 py-1 text-xs"
              onClick={() => {
                setSyncing(true);
                setError('');
                void refreshEngineWallet()
                  .then(() => refresh())
                  .catch((failure) =>
                    setError(
                      failure instanceof Error
                        ? failure.message
                        : String(failure)
                    )
                  )
                  .finally(() => setSyncing(false));
              }}
            >
              {syncing || engineSync.refreshing ? 'Syncing…' : 'Sync now'}
            </button>
          </div>
          <p className="mt-1 text-[11px] wallet-muted">
            {/*
              Reported separately from the balance on Home, which still comes
              from this renderer's own Electrum path. Showing them as one number
              would hide a disagreement, and a disagreement is the thing worth
              seeing while the two are being converged.
            */}
            {engineSync.confirmedSats === null
              ? 'This account has not been synchronized by the shared engine yet.'
              : `${(engineSync.confirmedSats / SATSINBITCOIN).toFixed(8)} BCH confirmed${
                  engineSync.pendingSats
                    ? ` · ${engineSync.pendingSats > 0 ? '+' : ''}${engineSync.pendingSats} sats pending`
                    : ''
                }`}
            {engineSync.source ? ` · ${engineSync.source}` : ''}
            {engineSync.tipHeight ? ` · tip ${engineSync.tipHeight}` : ''}
          </p>
          {engineSync.error && (
            <p className="mt-1 text-[11px] text-amber-400">
              {engineSync.error}
            </p>
          )}
        </div>
      )}

      <div className="space-y-2">
        {view.sources.map((source) => {
          const status = statusLine(source);
          return (
            <div
              key={source.id}
              data-testid={`chain-source-${source.id}`}
              className="rounded-xl border border-[var(--wallet-border)] wallet-surface-strong p-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold wallet-text-strong">
                    {source.label}
                    {source.role && (
                      <span className="ml-2 rounded border border-[var(--wallet-border)] px-1 py-px text-[9px] uppercase tracking-wide wallet-muted">
                        {source.role}
                      </span>
                    )}
                    {source.origin === 'own-infrastructure' && (
                      <span className="ml-1.5 rounded border border-[var(--wallet-border)] px-1 py-px text-[9px] uppercase tracking-wide wallet-muted">
                        mine
                      </span>
                    )}
                  </p>
                  <p className="truncate font-mono text-[11px] wallet-muted">
                    {source.endpoints
                      .map(
                        (endpoint) =>
                          `${endpoint.kind} ${endpoint.host}${
                            endpoint.port ? `:${endpoint.port}` : ''
                          }`
                      )
                      .join(' · ')}
                  </p>
                  <p className={`mt-1 text-[11px] ${status.tone}`}>
                    {status.text}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    className="wallet-btn-secondary px-2.5 py-1 text-xs"
                    onClick={() =>
                      void run(() =>
                        setChainSourceDisposition(
                          source.id,
                          source.disposition === 'enabled'
                            ? 'disabled'
                            : 'enabled'
                        )
                      )
                    }
                  >
                    {source.disposition === 'enabled' ? 'Disable' : 'Enable'}
                  </button>
                  {source.can_remove && (
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={`Remove ${source.label}`}
                      className="px-1.5 py-1 text-xs text-red-400/70 hover:text-red-400"
                      onClick={() =>
                        void run(() => removeChainSource(source.id))
                      }
                    >
                      🗑
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {showAdd ? (
        <div className="space-y-2 rounded-xl border border-[var(--wallet-border)] p-3">
          <input
            className="wallet-input w-full rounded-md px-3 py-2 text-sm wallet-text-strong"
            placeholder="host or ip[:port]"
            value={host}
            onChange={(event) => setHost(event.target.value)}
          />
          <input
            className="wallet-input w-full rounded-md px-3 py-2 text-sm wallet-text-strong"
            placeholder="Name (optional)"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
          />
          <select
            className="wallet-input w-full rounded-md px-3 py-2 text-sm wallet-text-strong"
            value={kind}
            onChange={(event) => setKind(event.target.value)}
            aria-label="Source type"
          >
            {ENDPOINT_KINDS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-2 text-xs wallet-muted">
            <input
              type="checkbox"
              checked={ownInfrastructure}
              onChange={(event) => setOwnInfrastructure(event.target.checked)}
            />
            This is my own infrastructure
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              className="wallet-btn-secondary flex-1 py-2 text-sm"
              onClick={() => setShowAdd(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busy}
              className="wallet-btn-primary flex-1 py-2 text-sm font-semibold"
              onClick={submitSource}
            >
              Add source
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="wallet-btn-secondary w-full py-2 text-sm"
          onClick={() => setShowAdd(true)}
        >
          Add a source
        </button>
      )}

      {error && <p className="text-xs text-red-400">{error}</p>}
    </SectionCard>
  );
}

export default ChainSourcesSettings;
