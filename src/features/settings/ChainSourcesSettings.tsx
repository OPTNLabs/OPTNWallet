import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type MutableRefObject,
} from 'react';
import { useDispatch } from 'react-redux';
import { setChainPolicy as rememberChainPolicy } from '../../state/slices/preferencesSlice';
import SectionCard from '../../components/ui/SectionCard';
import {
  addChainSource,
  CHAIN_POLICY_DESCRIPTIONS,
  CHAIN_POLICY_LABELS,
  ENDPOINT_KINDS,
  readChainSources,
  rebuildChainRoutes,
  trustSocksProxy,
  removeChainSource,
  SELECTABLE_CHAIN_POLICIES,
  setChainSelection,
  setChainPolicy,
  setChainSourceDisposition,
  type ChainSelection,
  type ChainSelectionProtocol,
  type ChainSourceScope,
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

type SourcePage =
  | 'overview'
  | 'public'
  | 'own'
  | 'custom'
  | 'metadata'
  | 'nostr'
  | 'details'
  | 'routing'
  | 'privacy'
  | 'sync'
  | 'birthday'
  | 'fusion'
  | 'fees'
  | 'explorer';
type DirectoryPage = Extract<SourcePage, 'public' | 'own' | 'custom'>;

const DIRECTORY_CONFIG: Record<
  DirectoryPage,
  { title: string; description: string; origin: ChainSource['origin'] }
> = {
  public: {
    title: 'Public Sources',
    description:
      'Browse the maintained public sources for this network. Opening this directory does not contact them.',
    origin: 'bootstrap',
  },
  own: {
    title: 'My Infrastructure',
    description:
      "Sources added here are marked as infrastructure you control and follow the wallet's current routing choices.",
    origin: 'own-infrastructure',
  },
  custom: {
    title: 'Custom Sources',
    description:
      "User-added sources stay in the custom directory and follow the wallet's current routing choices.",
    origin: 'user',
  },
};

const SERVICE_FILTERS = [
  { value: '', label: 'All services' },
  { value: 'electrum', label: 'Electrum / Fulcrum' },
  { value: 'p2p', label: 'BCH P2P' },
  { value: 'bip37', label: 'BIP37' },
  { value: 'neutrino', label: 'Compact filters' },
  { value: 'node-rpc', label: 'Node RPC' },
  { value: 'node-zmq', label: 'Notifications' },
  { value: 'ipfs-gateway', label: 'IPFS gateway' },
  { value: 'bcmr-indexer', label: 'BCMR indexer' },
];

const ROUTING_PROTOCOLS: {
  value: ChainSelectionProtocol;
  label: string;
}[] = [
  { value: 'FulcrumElectrum', label: 'Electrum / Fulcrum' },
  { value: 'Bip37', label: 'BIP37' },
  { value: 'Neutrino', label: 'Compact filters' },
  { value: 'BchnRpc', label: 'Node RPC' },
  { value: 'BchnZmq', label: 'Node notifications' },
];

function isDirectoryPage(page: SourcePage): page is DirectoryPage {
  return page === 'public' || page === 'own' || page === 'custom';
}

function pageTitle(page: SourcePage): string {
  if (isDirectoryPage(page)) return DIRECTORY_CONFIG[page].title;
  return {
    overview: 'Network',
    metadata: 'Metadata & indexing',
    nostr: 'Nostr relays',
    details: 'Source details',
    routing: 'Routing',
    privacy: 'Privacy & Transport',
    sync: 'Diagnostics',
    fees: 'Transaction fees',
    fusion: 'CashFusion',
    birthday: 'Wallet birthday',
    explorer: 'Explorer',
  }[page];
}

function endpointText(endpoint: ChainSource['endpoints'][number]): string {
  return `${endpoint.kind} ${endpoint.host}${
    endpoint.port ? `:${endpoint.port}` : ''
  }`;
}

function serviceBadgeText(kind: string): string {
  if (kind.includes('electrum')) return 'Electrum';
  if (kind === 'p2p') return 'BIP37 / P2P';
  if (kind === 'node-rpc') return 'RPC';
  if (kind === 'node-zmq') return 'ZMQ';
  if (kind === 'ipfs-gateway') return 'IPFS';
  if (kind === 'bcmr-indexer') return 'BCMR';
  return kind;
}

function protocolBadgeText(protocol: string): string {
  if (protocol.toLowerCase().includes('electrum')) return 'Electrum';
  if (protocol.toLowerCase().includes('bip37')) return 'BIP37';
  if (protocol.toLowerCase().includes('neutrino')) return 'Compact filters';
  if (protocol.toLowerCase().includes('rpc')) return 'RPC';
  if (protocol.toLowerCase().includes('zmq')) return 'ZMQ';
  return protocol;
}

function sourceBadges(source: ChainSource): string[] {
  const badges = [
    ...source.endpoints.map((endpoint) => serviceBadgeText(endpoint.kind)),
    ...(source.protocol_statuses ?? []).map((status) =>
      protocolBadgeText(status.protocol)
    ),
    ...(source.capability_details ?? []).map((capability) => capability.name),
  ];
  return [...new Set(badges)].slice(0, 6);
}

function originText(source: ChainSource): string {
  if (source.origin === 'bootstrap') return 'Maintained public catalog';
  if (source.origin === 'own-infrastructure') return 'My infrastructure';
  return 'User-added source';
}

function confidenceText(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function scopeKey(
  scope: ChainSourceScope
): 'all' | 'public' | 'own' | 'selected' {
  if (scope === 'AllEnabled') return 'all';
  if (scope === 'PublicEnabled') return 'public';
  if (scope === 'MyInfrastructure') return 'own';
  return 'selected';
}

function scopeFromKey(
  key: string,
  previous: ChainSourceScope
): ChainSourceScope {
  if (key === 'public') return 'PublicEnabled';
  if (key === 'own') return 'MyInfrastructure';
  if (key === 'selected') {
    return typeof previous === 'object' && 'Selected' in previous
      ? { Selected: [...previous.Selected] }
      : { Selected: [] };
  }
  return 'AllEnabled';
}

function selectedSourceIds(scope: ChainSourceScope): string[] | null {
  return typeof scope === 'object' && 'Selected' in scope
    ? scope.Selected
    : null;
}

function toggleSource(scope: ChainSourceScope, id: string, checked: boolean) {
  const ids = selectedSourceIds(scope);
  if (!ids) return scope;
  const next = ids.filter((sourceId) => sourceId !== id);
  if (checked) next.push(id);
  return { Selected: next };
}

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
      text: 'Wallet route available',
      tone: 'text-[var(--wallet-accent)]',
    };
  }
  if (source.failures.length > 0) {
    return {
      text: `Route unavailable · ${source.failures[0].error}`,
      tone: 'text-amber-400',
    };
  }
  if (source.role) {
    return { text: 'Selected route unavailable', tone: 'text-amber-400' };
  }
  return { text: 'No wallet route in current selection', tone: 'wallet-muted' };
}

type ChainSourcesSettingsProps = {
  explorerSettings?: ReactNode;
  feeSettings?: ReactNode;
  fusionSettings?: ReactNode;
  nostrSettings?: ReactNode;
  birthdaySettings?: ReactNode;
  backRef?: MutableRefObject<(() => void) | null>;
};

export function ChainSourcesSettings({
  explorerSettings,
  feeSettings,
  fusionSettings,
  nostrSettings,
  birthdaySettings,
  backRef,
}: ChainSourcesSettingsProps) {
  const [view, setView] = useState<ChainSourcesView | null>(null);
  const [page, setPage] = useState<SourcePage>('overview');
  const [history, setHistory] = useState<SourcePage[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState('');
  const [search, setSearch] = useState('');
  const [serviceFilter, setServiceFilter] = useState('');
  const [error, setError] = useState('');
  const [refreshError, setRefreshError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [host, setHost] = useState('');
  const [label, setLabel] = useState('');
  const [serviceStep, setServiceStep] = useState(false);
  const [services, setServices] = useState<Record<string, string>>({});
  const [extendingSource, setExtendingSource] = useState<ChainSource | null>(
    null
  );
  const [ownInfrastructure, setOwnInfrastructure] = useState(false);
  const [engineSync, setEngineSync] = useState<EngineWalletSync | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [torStarting, setTorStarting] = useState(false);
  const [torProgress, setTorProgress] = useState<number | null>(null);
  const [selection, setSelection] = useState<ChainSelection | null>(null);
  const [selectionDirty, setSelectionDirty] = useState(false);
  const selectionNetwork = useRef<string | null>(null);

  const dispatch = useDispatch();

  const refresh = useCallback(async () => {
    try {
      const current = await readChainSources();
      setView(current);
      // Mirror the runtime's policy into the renderer, because explorer links
      // obey it too: a holder on "own infrastructure only" has not agreed to
      // tell a public explorer which transactions are theirs. Persisted with
      // the preferences, so the answer is already right at the next start
      // rather than briefly reading as Auto.
      dispatch(rememberChainPolicy(current.policy));
      setEngineSync(await readEngineWalletSync());
      setRefreshError('');
    } catch (failure) {
      setRefreshError(
        failure instanceof Error ? failure.message : String(failure)
      );
    }
  }, [dispatch]);

  useEffect(() => {
    void refresh();
    // Read the Rust view after edits so route status stays truthful without
    // making the renderer probe sources.
    const timer = setInterval(() => void refresh(), 4000);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (!view) return;
    if (selectionNetwork.current !== view.network) {
      selectionNetwork.current = view.network;
      setSelection(view.selection ?? null);
      setSelectionDirty(false);
      return;
    }
    if (!selectionDirty) setSelection(view.selection ?? null);
  }, [view, selectionDirty]);

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

  const navigate = (next: SourcePage) => {
    if (next !== 'routing') setSelectionDirty(false);
    if (next === page) return;
    setHistory((previous) => [...previous, page]);
    setPage(next);
  };

  const goBack = useCallback(() => {
    if (showAdd) {
      if (serviceStep && !extendingSource) {
        setServiceStep(false);
        return;
      }
      setShowAdd(false);
      return;
    }
    const previous = history[history.length - 1];
    if (!previous) return;
    setPage(previous);
    setHistory((pages) => pages.slice(0, -1));
    setSelectionDirty(false);
  }, [history, showAdd, serviceStep, extendingSource]);

  useEffect(() => {
    if (!backRef) return;
    backRef.current = history.length || showAdd ? goBack : null;
    return () => {
      backRef.current = null;
    };
  }, [backRef, goBack, history.length, showAdd]);

  const openDirectory = (next: DirectoryPage) => {
    setShowAdd(false);
    navigate(next);
  };

  const openDetails = (source: ChainSource) => {
    setSelectedSourceId(source.id);
    setShowAdd(false);
    navigate('details');
  };

  const openAdd = () => {
    setOwnInfrastructure(page === 'own');
    setHost('');
    setLabel('');
    setServices({});
    setServiceStep(false);
    setExtendingSource(null);
    setShowAdd(true);
  };

  const selectedSource = view?.sources.find(
    (source) => source.id === selectedSourceId
  );

  const directorySources = isDirectoryPage(page)
    ? (view?.sources ?? []).filter((source) => {
        const config = DIRECTORY_CONFIG[page];
        const query = search.trim().toLowerCase();
        return (
          source.origin === config.origin &&
          (query.length === 0 ||
            source.label.toLowerCase().includes(query) ||
            source.endpoints.some((endpoint) =>
              endpoint.host.toLowerCase().includes(query)
            )) &&
          (serviceFilter.length === 0 ||
            source.endpoints.some((endpoint) =>
              endpoint.kind.includes(serviceFilter)
            ) ||
            (source.protocol_statuses ?? []).some(
              (status) =>
                status.protocol === serviceFilter &&
                (status.status === 'advertised' || status.status === 'verified')
            ))
        );
      })
    : [];

  const updateSelection = (
    update: (current: ChainSelection) => ChainSelection
  ) => {
    setSelection((current) => (current ? update(current) : current));
    setSelectionDirty(true);
  };

  const saveSelection = () => {
    if (!selection || !view) return;
    const network = view.network;
    void run(async () => {
      await setChainSelection(selection, network);
      setSelectionDirty(false);
    });
  };

  const submitSource = () => {
    if (!view) return;
    const entry = host.trim();
    if (!entry) {
      setError('Enter a host or IP address.');
      return;
    }
    const selected = Object.entries(services).map(([kind, value]) => ({
      kind,
      port: /^\d+$/.test(value) ? Number(value) : NaN,
    }));
    if (
      selected.length === 0 ||
      selected.some(
        ({ port }) => !Number.isInteger(port) || port < 1 || port > 65535
      )
    ) {
      setError(
        'Select at least one service and enter its configured port (1–65535).'
      );
      return;
    }
    const [first, ...additional] = selected;
    const network = view.network;
    void run(async () => {
      await addChainSource({
        label: label.trim() || entry,
        kind: first.kind,
        host: entry,
        port: first.port,
        services: additional,
        infrastructureGroup:
          extendingSource?.group ?? (ownInfrastructure ? 'mine' : null),
        network,
      });
      setHost('');
      setLabel('');
      setOwnInfrastructure(false);
      setShowAdd(false);
    });
  };

  const serviceForm = (
    <section
      aria-label="Configure source services"
      className="space-y-3 rounded-xl border border-[var(--wallet-border)] p-3"
    >
      {!serviceStep ? (
        <>
          <label className="block text-sm wallet-text-strong">
            Name
            <input
              className="wallet-input w-full rounded-md px-3 py-2"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="Home node"
            />
          </label>
          <label className="block text-sm wallet-text-strong">
            Host or IP address
            <input
              className="wallet-input w-full rounded-md px-3 py-2"
              value={host}
              onChange={(event) => setHost(event.target.value)}
              placeholder="node.home"
            />
          </label>
          <p className="text-xs wallet-muted">
            Add this source once, then configure the services it exposes. Enter
            ports in the next step.
          </p>
          <button
            type="button"
            className="wallet-btn-primary px-3 py-2"
            disabled={!host.trim() || busy}
            onClick={() => {
              setServiceStep(true);
              setError('');
            }}
          >
            Continue
          </button>
        </>
      ) : (
        <>
          <p className="font-semibold wallet-text-strong">{label || host}</p>
          <p className="text-xs wallet-muted">
            {host} — one source, multiple services. Select only services you
            have configured. These settings do not prove availability or
            capabilities.
          </p>
          {ENDPOINT_KINDS.map((service) => {
            const configured =
              extendingSource?.endpoints.filter(
                (endpoint) => endpoint.kind === service.value
              ) ?? [];
            return (
              <div key={service.value} className="space-y-1">
                <label className="flex items-center gap-2 text-sm wallet-text-strong">
                  <input
                    type="checkbox"
                    disabled={busy || configured.length > 0}
                    checked={configured.length > 0 || service.value in services}
                    onChange={(event) =>
                      setServices((previous) => {
                        const next = { ...previous };
                        if (event.target.checked) next[service.value] = '';
                        else delete next[service.value];
                        return next;
                      })
                    }
                  />
                  {service.label}
                </label>
                {configured.length > 0 && (
                  <p className="text-xs wallet-muted">
                    Already configured:{' '}
                    {configured.map((endpoint) => endpoint.port).join(', ')}
                  </p>
                )}
                {service.value in services && (
                  <label className="block text-xs wallet-muted">
                    {service.label} port
                    <input
                      className="wallet-input w-full rounded-md px-3 py-2"
                      inputMode="numeric"
                      value={services[service.value]}
                      disabled={busy}
                      onChange={(event) =>
                        setServices((previous) => ({
                          ...previous,
                          [service.value]: event.target.value,
                        }))
                      }
                    />
                  </label>
                )}
              </div>
            );
          })}
          {(view?.unavailable_services?.length ?? 0) > 0 && (
            <fieldset className="space-y-2">
              <legend className="text-sm font-semibold wallet-text-strong">
                Metadata and indexing services
              </legend>
              <p className="text-xs wallet-muted">
                Optional services for this source. Local Rust BCMR resolution
                remains separate from external indexers.
              </p>
              {view?.unavailable_services?.map((service) => (
                <div key={service.id}>
                  <label className="flex items-center gap-2 text-sm wallet-muted">
                    <input
                      type="checkbox"
                      disabled
                      checked={false}
                      aria-describedby={`unavailable-${service.id}`}
                    />
                    {service.label}
                  </label>
                  <p
                    id={`unavailable-${service.id}`}
                    className="text-xs wallet-muted"
                  >
                    {service.reason}
                  </p>
                </div>
              ))}
            </fieldset>
          )}
          <p className="text-xs wallet-muted">
            P2P support is verified separately. RPC may require authentication.
            ZMQ provides notifications, not wallet synchronization. Fulcrum is a
            separate service and is never assumed. IPFS gateways use HTTPS at
            /ipfs/ through verified Tor; enter the HTTPS port (usually 443).
            Registry hashes are checked in Rust.
          </p>
          <button
            type="button"
            className="wallet-btn-primary px-3 py-2"
            disabled={busy || Object.keys(services).length === 0}
            onClick={submitSource}
          >
            {extendingSource ? 'Save services' : 'Save source'}
          </button>
        </>
      )}
      <button
        type="button"
        disabled={busy}
        className="wallet-btn-secondary px-3 py-2"
        onClick={() => setShowAdd(false)}
      >
        Cancel
      </button>
    </section>
  );

  if (!view) {
    return (
      <SectionCard className="p-4">
        <p className="text-sm wallet-muted">
          {refreshError || 'Reading chain sources…'}
        </p>
      </SectionCard>
    );
  }

  return (
    <SectionCard className="p-4 space-y-4">
      <div className="space-y-2">
        {!backRef && (history.length > 0 || showAdd) && (
          <button
            type="button"
            className="wallet-btn-secondary px-2.5 py-1 text-xs"
            onClick={goBack}
          >
            Back
          </button>
        )}
        <p className="text-sm font-semibold wallet-text-strong">
          {pageTitle(page)}
        </p>
        {page !== 'nostr' && (
          <p className="mt-1 text-xs wallet-muted">
            {page === 'metadata' ? (
              view.network
            ) : (
              <>
                {view.network} · {view.wallet_routes} route
                {view.wallet_routes === 1 ? '' : 's'} able to sync right now
                {view.verified_tip
                  ? ` · verified header ${view.verified_tip.height}`
                  : ' · no verified headers yet'}
              </>
            )}
          </p>
        )}
      </div>

      {page === 'overview' && (
        <>
          <p className="text-xs wallet-muted">
            Choose a source directory, review a source, or adjust how the wallet
            routes chain access.
          </p>
          <p role="status" className="text-xs wallet-muted">
            {engineSync?.refreshing
              ? 'Syncing wallet...'
              : engineSync?.error
                ? `Sync needs attention: ${engineSync.error}`
                : engineSync?.confirmedSats !== null && engineSync
                  ? 'Last synchronized balance available'
                  : 'Waiting for wallet sync'}
          </p>
          <nav aria-label="Network source settings" className="space-y-2">
            <button
              type="button"
              className="wallet-surface-strong flex w-full items-center justify-between rounded-xl border border-[var(--wallet-border)] p-3 text-left"
              onClick={() => navigate('routing')}
            >
              <span>
                <span className="block text-sm font-semibold wallet-text-strong">
                  Routing
                </span>
                <span className="block text-[11px] wallet-muted">
                  {CHAIN_POLICY_LABELS[view.policy]} ·{' '}
                  {view.protocols.length > 0
                    ? view.protocols.join(', ')
                    : 'no protocols selected'}
                </span>
              </span>
              <span className="text-xs wallet-muted">Configure</span>
            </button>
            {(['own', 'public', 'custom'] as DirectoryPage[]).map((target) => {
              const config = DIRECTORY_CONFIG[target];
              const count = view.sources.filter(
                (source) => source.origin === config.origin
              ).length;
              return (
                <Fragment key={target}>
                  <button
                    key={target}
                    type="button"
                    data-testid={`chain-sources-${target}`}
                    className="wallet-surface-strong flex w-full items-center justify-between rounded-xl border border-[var(--wallet-border)] p-3 text-left"
                    onClick={() => openDirectory(target)}
                  >
                    <span>
                      <span className="block text-sm font-semibold wallet-text-strong">
                        {config.title}
                      </span>
                      <span className="block text-[11px] wallet-muted">
                        {count} known source{count === 1 ? '' : 's'}
                      </span>
                    </span>
                    <span className="text-xs wallet-muted">Open</span>
                  </button>
                  {target === 'public' && (
                    <button
                      type="button"
                      className="wallet-surface-strong w-full rounded-xl border border-[var(--wallet-border)] p-3 text-left"
                      onClick={() => navigate('metadata')}
                    >
                      <span className="block text-sm font-semibold wallet-text-strong">
                        Metadata &amp; indexing
                      </span>
                      <span className="block text-[11px] wallet-muted">
                        BCMR · Paytaca-compatible services · Chaingraph · IPFS
                      </span>
                    </button>
                  )}
                </Fragment>
              );
            })}
            <button
              type="button"
              className="wallet-surface-strong flex w-full items-center justify-between rounded-xl border border-[var(--wallet-border)] p-3 text-left"
              onClick={() => navigate('privacy')}
            >
              <span>
                <span className="block text-sm font-semibold wallet-text-strong">
                  Privacy &amp; Transport
                </span>
                <span className="block text-[11px] wallet-muted">
                  Tor (last checked): {view.tor.status.replace('_', ' ')}
                </span>
              </span>
              <span className="text-xs wallet-muted">Open</span>
            </button>
            <button
              type="button"
              className="wallet-surface-strong flex w-full items-center justify-between rounded-xl border border-[var(--wallet-border)] p-3 text-left"
              onClick={() => navigate('sync')}
            >
              <span>
                <span className="block text-sm font-semibold wallet-text-strong">
                  Diagnostics
                </span>
                <span className="block text-[11px] wallet-muted">
                  Connection details and manual refresh
                </span>
              </span>
              <span className="text-xs wallet-muted">Open</span>
            </button>
            {nostrSettings && (
              <button
                type="button"
                className="wallet-surface-strong flex w-full items-center justify-between gap-3 rounded-xl border border-[var(--wallet-border)] p-3 text-left"
                onClick={() => navigate('nostr')}
              >
                <span>
                  <span className="block text-sm font-semibold wallet-text-strong">
                    Nostr relays
                  </span>
                  <span className="block text-[11px] wallet-muted">
                    Saved relay pool and custom endpoints
                  </span>
                </span>
                <span className="text-xs wallet-muted">Open</span>
              </button>
            )}
            {birthdaySettings && (
              <button
                type="button"
                className="wallet-surface-strong flex w-full items-center justify-between rounded-xl border border-[var(--wallet-border)] p-3 text-left"
                onClick={() => navigate('birthday')}
              >
                <span>
                  <span className="block text-sm font-semibold wallet-text-strong">
                    Wallet birthday
                  </span>
                  <span className="block text-[11px] wallet-muted">
                    Where wallet history begins
                  </span>
                </span>
                <span aria-hidden="true">&#8250;</span>
              </button>
            )}
            {fusionSettings && (
              <button
                type="button"
                className="wallet-surface-strong flex w-full items-center justify-between rounded-xl border border-[var(--wallet-border)] p-3 text-left"
                onClick={() => navigate('fusion')}
              >
                <span>
                  <span className="block text-sm font-semibold wallet-text-strong">
                    CashFusion
                  </span>
                  <span className="block text-[11px] wallet-muted">
                    Automatic server selection and server pool
                  </span>
                </span>
                <span aria-hidden="true">&#8250;</span>
              </button>
            )}
            {feeSettings && (
              <button
                type="button"
                className="wallet-surface-strong flex w-full items-center justify-between rounded-xl border border-[var(--wallet-border)] p-3 text-left"
                onClick={() => navigate('fees')}
              >
                <span className="text-sm font-semibold wallet-text-strong">
                  Transaction fees
                </span>
                <span aria-hidden="true">›</span>
              </button>
            )}
            <button
              type="button"
              className="wallet-surface-strong flex w-full items-center justify-between rounded-xl border border-[var(--wallet-border)] p-3 text-left"
              onClick={() => navigate('explorer')}
            >
              <span>
                <span className="block text-sm font-semibold wallet-text-strong">
                  Explorer
                </span>
                <span className="block text-[11px] wallet-muted">
                  Choose the explorer used by existing wallet links
                </span>
              </span>
              <span className="text-xs wallet-muted">Open</span>
            </button>
          </nav>
        </>
      )}

      {page === 'fees' && feeSettings}
      {page === 'fusion' && fusionSettings}
      {page === 'nostr' && nostrSettings}
      {page === 'birthday' && birthdaySettings}

      {page === 'privacy' && (
        <>
          <p className="text-xs wallet-muted">
            Public sources use the host&apos;s verified Tor route.
            Infrastructure explicitly marked as yours may use the direct route
            allowed by the Rust policy; this screen does not change that policy.
          </p>
          {view.tor.status === 'unverified' && view.tor.socks_port !== null && (
            <div className="rounded-lg border border-[var(--wallet-warning-border)] bg-[var(--wallet-warning-bg)] px-3 py-2 text-xs text-[var(--wallet-warning-text)]">
              <p>
                A SOCKS proxy is listening on port {view.tor.socks_port}, but
                this wallet cannot tell whether it is Tor — every SOCKS proxy
                answers the same way, so a corporate proxy or an SSH tunnel
                looks identical. Until you confirm it, public sources stay
                refused rather than sending traffic through a proxy that may not
                be anonymising it.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  data-testid="trust-socks-proxy"
                  className="wallet-btn-secondary px-3 py-1.5 text-xs"
                  onClick={() => {
                    const port = view.tor.socks_port;
                    if (port === null) return;
                    void trustSocksProxy(port, true, view.network)
                      .then(() => rebuildChainRoutes())
                      .then(() => refresh())
                      .catch((failure) =>
                        setError(
                          failure instanceof Error
                            ? failure.message
                            : String(failure)
                        )
                      );
                  }}
                >
                  Yes, {view.tor.socks_port} is my Tor
                </button>
              </div>
            </div>
          )}

          {view.tor.trusted_ports.length > 0 && (
            <p className="wallet-muted text-xs">
              Trusted proxy ports: {view.tor.trusted_ports.join(', ')}.{' '}
              <button
                type="button"
                data-testid="untrust-socks-proxies"
                className="underline"
                onClick={() => {
                  void Promise.all(
                    view.tor.trusted_ports.map((port) =>
                      trustSocksProxy(port, false, view.network)
                    )
                  )
                    .then(() => rebuildChainRoutes())
                    .then(() => refresh())
                    .catch((failure) =>
                      setError(
                        failure instanceof Error
                          ? failure.message
                          : String(failure)
                      )
                    );
                }}
              >
                Withdraw
              </button>
            </p>
          )}

          {refusedForWantOfTor(view.sources) && (
            <div className="rounded-lg border border-[var(--wallet-warning-border)] bg-[var(--wallet-warning-bg)] px-3 py-2 text-xs text-[var(--wallet-warning-text)]">
              <p>
                Public sources are reached through Tor, and no verified proxy is
                running. A source you mark as your own is dialled directly
                instead.
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
                      .then((status) =>
                        setTorProgress(status.bootstrap_percent)
                      )
                      .catch(() => undefined);
                  }, 1500);
                  void startIntegratedTor()
                    // The proxy exists now; the stack still holds routes built
                    // when it did not, so ask for a rebuild before reading back.
                    .then(() => rebuildChainRoutes())
                    .then(() => refresh())
                    .catch((failure) =>
                      setError(
                        failure instanceof Error
                          ? failure.message
                          : String(failure)
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
        </>
      )}

      {page === 'routing' && (
        <>
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
              Routing choice
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
                void run(async () => {
                  setSelectionDirty(false);
                  await setChainPolicy(
                    next as Exclude<typeof view.policy, 'custom'>,
                    view.network
                  );
                });
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
              {view.protocols.length > 0
                ? ` · ${view.protocols.join(', ')}`
                : ''}
            </p>
          </div>

          {selection ? (
            <section
              aria-label="Advanced source selection"
              className="space-y-3 rounded-xl border border-[var(--wallet-border)] wallet-surface-strong p-3"
            >
              <div>
                <p className="text-xs font-semibold wallet-text-strong">
                  Selection and failover
                </p>
                <p className="mt-1 text-[11px] wallet-muted">
                  Choose which source pools and services the wallet may use.
                  Saving applies the complete selection.
                </p>
              </div>
              <label className="block text-xs wallet-muted">
                <span className="font-semibold wallet-text-strong">
                  Primary source pool
                </span>
                <select
                  className="wallet-input mt-1.5 w-full rounded-md px-3 py-2 text-sm wallet-text-strong"
                  disabled={busy}
                  value={scopeKey(selection.primary_scope)}
                  onChange={(event) =>
                    updateSelection((current) => ({
                      ...current,
                      primary_scope: scopeFromKey(
                        event.target.value,
                        current.primary_scope
                      ),
                    }))
                  }
                >
                  <option value="all">All enabled sources</option>
                  <option value="public">Public sources</option>
                  <option value="own">My infrastructure</option>
                  <option value="selected">Selected sources below</option>
                </select>
              </label>
              <label className="block text-xs wallet-muted">
                <span className="font-semibold wallet-text-strong">
                  Fallback source pool
                </span>
                <select
                  className="wallet-input mt-1.5 w-full rounded-md px-3 py-2 text-sm wallet-text-strong"
                  disabled={busy}
                  value={
                    selection.fallback_scope
                      ? scopeKey(selection.fallback_scope)
                      : 'none'
                  }
                  onChange={(event) =>
                    updateSelection((current) => ({
                      ...current,
                      fallback_scope:
                        event.target.value === 'none'
                          ? null
                          : scopeFromKey(
                              event.target.value,
                              current.fallback_scope ?? 'AllEnabled'
                            ),
                    }))
                  }
                >
                  <option value="none">No fallback</option>
                  <option value="all">All enabled sources</option>
                  <option value="public">Public sources</option>
                  <option value="own">My infrastructure</option>
                  <option value="selected">Selected sources below</option>
                </select>
              </label>
              <fieldset disabled={busy} className="space-y-1">
                <legend className="text-xs font-semibold wallet-text-strong">
                  Allowed chain access
                </legend>
                {ROUTING_PROTOCOLS.filter(
                  (protocol) => protocol.value !== 'BchnZmq'
                ).map((protocol) => (
                  <label
                    key={protocol.value}
                    className="flex items-center gap-2 text-xs wallet-muted"
                  >
                    <input
                      type="checkbox"
                      checked={selection.protocols.includes(protocol.value)}
                      onChange={(event) =>
                        updateSelection((current) => ({
                          ...current,
                          protocols: event.target.checked
                            ? current.protocols.includes(protocol.value)
                              ? current.protocols
                              : [...current.protocols, protocol.value]
                            : current.protocols.filter(
                                (value) => value !== protocol.value
                              ),
                        }))
                      }
                    />
                    {protocol.label}
                  </label>
                ))}
              </fieldset>
              <fieldset disabled={busy} className="space-y-1">
                <legend className="text-xs font-semibold wallet-text-strong">
                  Event sources
                </legend>
                <label className="flex items-center gap-2 text-xs wallet-muted">
                  <input
                    type="checkbox"
                    checked={selection.protocols.includes('BchnZmq')}
                    onChange={(event) =>
                      updateSelection((current) => ({
                        ...current,
                        protocols: event.target.checked
                          ? current.protocols.includes('BchnZmq')
                            ? current.protocols
                            : [...current.protocols, 'BchnZmq']
                          : current.protocols.filter(
                              (value) => value !== 'BchnZmq'
                            ),
                      }))
                    }
                  />
                  Node notifications (ZMQ)
                </label>
                <p className="text-[11px] wallet-muted">
                  Notifications may wake reconciliation; they are not a
                  synchronization mode or verification proof.
                </p>
              </fieldset>
              {view.sources.map((source) => {
                const primarySelected = selectedSourceIds(
                  selection.primary_scope
                );
                const fallbackSelected = selection.fallback_scope
                  ? selectedSourceIds(selection.fallback_scope)
                  : null;
                const preference = selection.preferred.indexOf(source.id);
                return (
                  <div
                    key={source.id}
                    className="rounded-lg border border-[var(--wallet-border)] p-2.5"
                  >
                    <p className="text-xs font-semibold wallet-text-strong">
                      {source.label}
                    </p>
                    {primarySelected && (
                      <label className="mt-1 flex items-center gap-2 text-xs wallet-muted">
                        <input
                          type="checkbox"
                          checked={primarySelected.includes(source.id)}
                          onChange={(event) =>
                            updateSelection((current) => ({
                              ...current,
                              primary_scope: toggleSource(
                                current.primary_scope,
                                source.id,
                                event.target.checked
                              ),
                            }))
                          }
                        />
                        Primary pool
                      </label>
                    )}
                    {fallbackSelected && (
                      <label className="mt-1 flex items-center gap-2 text-xs wallet-muted">
                        <input
                          type="checkbox"
                          checked={fallbackSelected.includes(source.id)}
                          onChange={(event) =>
                            updateSelection((current) => ({
                              ...current,
                              fallback_scope: current.fallback_scope
                                ? toggleSource(
                                    current.fallback_scope,
                                    source.id,
                                    event.target.checked
                                  )
                                : null,
                            }))
                          }
                        />
                        Fallback pool
                      </label>
                    )}
                    <button
                      type="button"
                      disabled={busy}
                      className="wallet-btn-secondary mt-2 px-2.5 py-1 text-xs"
                      onClick={() =>
                        updateSelection((current) => ({
                          ...current,
                          preferred: [
                            source.id,
                            ...current.preferred.filter(
                              (sourceId) => sourceId !== source.id
                            ),
                          ],
                        }))
                      }
                    >
                      Prefer first
                    </button>
                    {preference >= 0 && (
                      <button
                        type="button"
                        disabled={busy}
                        className="wallet-btn-secondary ml-2 mt-2 px-2.5 py-1 text-xs"
                        onClick={() =>
                          updateSelection((current) => ({
                            ...current,
                            preferred: current.preferred.filter(
                              (id) => id !== source.id
                            ),
                          }))
                        }
                      >
                        Remove preference
                      </button>
                    )}
                    {preference >= 0 && (
                      <span className="ml-2 text-[11px] wallet-muted">
                        Preference {preference + 1}
                      </span>
                    )}
                  </div>
                );
              })}
              <button
                type="button"
                disabled={busy || !selectionDirty}
                className="wallet-btn-primary w-full py-2 text-sm font-semibold"
                onClick={saveSelection}
              >
                Save selection
              </button>
            </section>
          ) : (
            <p className="text-xs wallet-muted">
              Advanced selection is unavailable in this host response.
            </p>
          )}
        </>
      )}

      {page === 'sync' &&
        (engineSync ? (
          <div className="rounded-xl border border-[var(--wallet-border)] wallet-surface-strong p-3">
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs font-semibold wallet-text-strong">
                Wallet sync
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
        ) : (
          <p className="text-xs wallet-muted">
            Shared engine sync is unavailable right now.
          </p>
        ))}

      {page === 'metadata' && (
        <section
          aria-label="Metadata and indexing services"
          className="space-y-3"
        >
          <p className="text-xs wallet-muted">
            Token ownership comes from wallet sync. Rust verifies token identity
            locally; optional services provide metadata or indexed queries
            within your routing and privacy choices. Opening this page contacts
            no providers.
          </p>
          <div className="rounded-xl border border-[var(--wallet-border)] p-3 space-y-2">
            <p className="text-sm font-semibold wallet-text-strong">
              BCMR indexers
            </p>
            <p className="text-xs wallet-muted">
              Maintained services for {view.network} appear below. You can also
              add your own indexer. Requires verified Tor. Registry bytes must
              match the locally verified publication; an indexer cannot
              establish ownership or replace missing chain evidence.
            </p>
            {view.sources
              .filter((source) =>
                source.endpoints.some(
                  (endpoint) => endpoint.kind === 'bcmr-indexer'
                )
              )
              .map((source) => (
                <button
                  key={source.id}
                  type="button"
                  className="wallet-btn-secondary block px-3 py-2"
                  onClick={() => openDetails(source)}
                >
                  {source.label} · {source.disposition}
                </button>
              ))}
            <button
              type="button"
              className="wallet-btn-secondary px-3 py-2"
              onClick={() => {
                openDirectory('custom');
                openAdd();
                setServices({ 'bcmr-indexer': '443' });
              }}
            >
              Add BCMR indexer
            </button>
          </div>
          <div className="rounded-xl border border-[var(--wallet-border)] p-3 space-y-2">
            <p className="text-sm font-semibold wallet-text-strong">
              IPFS gateways
            </p>
            <p className="text-xs wallet-muted">
              Maintained and custom HTTPS gateways. Requires verified Tor;
              registry bytes are hash-checked by Rust.
            </p>
            {view.sources
              .filter((source) =>
                source.endpoints.some(
                  (endpoint) => endpoint.kind === 'ipfs-gateway'
                )
              )
              .map((source) => (
                <button
                  key={source.id}
                  type="button"
                  className="wallet-btn-secondary block px-3 py-2"
                  onClick={() => openDetails(source)}
                >
                  {source.label}
                </button>
              ))}
            <button
              type="button"
              className="wallet-btn-secondary px-3 py-2"
              onClick={() => openDirectory('custom')}
            >
              External / custom sources
            </button>
            <button
              type="button"
              className="wallet-btn-secondary px-3 py-2"
              onClick={() => openDirectory('own')}
            >
              My infrastructure
            </button>
          </div>
          {(view.unavailable_services ?? []).map((service) => (
            <div
              key={service.id}
              className="rounded-xl border border-[var(--wallet-border)] p-3"
            >
              <button
                type="button"
                disabled
                className="wallet-muted text-sm"
                aria-describedby={`metadata-${service.id}`}
              >
                {service.label} — unavailable
              </button>
              <p id={`metadata-${service.id}`} className="text-xs wallet-muted">
                {service.reason}
              </p>
            </div>
          ))}
        </section>
      )}

      {isDirectoryPage(page) && (
        <>
          <p className="text-xs wallet-muted">
            {DIRECTORY_CONFIG[page].description}
          </p>
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
            <input
              type="search"
              aria-label="Search sources"
              className="wallet-input rounded-md px-3 py-2 text-sm wallet-text-strong"
              placeholder="Search sources"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <select
              aria-label="Service filter"
              className="wallet-input rounded-md px-3 py-2 text-sm wallet-text-strong"
              value={serviceFilter}
              onChange={(event) => setServiceFilter(event.target.value)}
            >
              {SERVICE_FILTERS.map((filter) => (
                <option key={filter.value} value={filter.value}>
                  {filter.label}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            {directorySources.length === 0 ? (
              <p className="text-xs wallet-muted">
                No sources match this directory.
              </p>
            ) : (
              directorySources.map((source) => {
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
                        </p>
                        <p className="truncate text-[11px] wallet-muted">
                          {originText(source)}
                          {source.group ? ` · ${source.group}` : ''}
                        </p>
                        <p className="truncate font-mono text-[11px] wallet-muted">
                          {[
                            ...new Set(
                              source.endpoints.map((endpoint) => endpoint.host)
                            ),
                          ].join(' · ')}
                        </p>
                        <div className="mt-1 flex flex-wrap gap-1">
                          {sourceBadges(source).map((badge) => (
                            <span
                              key={badge}
                              className="rounded border border-[var(--wallet-border)] px-1.5 py-px text-[9px] wallet-muted"
                            >
                              {badge}
                            </span>
                          ))}
                        </div>
                        <p className={`mt-1 text-[11px] ${status.tone}`}>
                          {status.text}
                        </p>
                      </div>
                      <button
                        type="button"
                        className="wallet-btn-secondary shrink-0 px-2.5 py-1 text-xs"
                        onClick={() => openDetails(source)}
                      >
                        View details
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
          {page !== 'public' &&
            (showAdd ? (
              serviceForm
            ) : (
              <button
                type="button"
                className="wallet-btn-secondary w-full py-2 text-sm"
                onClick={openAdd}
              >
                {page === 'own' ? 'Add infrastructure' : 'Add a source'}
              </button>
            ))}
        </>
      )}

      {page === 'details' &&
        (selectedSource ? (
          <div className="space-y-4">
            <div>
              <p className="text-base font-semibold wallet-text-strong">
                {selectedSource.label}
              </p>
              <p className="text-xs wallet-muted">
                {originText(selectedSource)}
                {selectedSource.group ? ` · ${selectedSource.group}` : ''}
                {selectedSource.role ? ` · ${selectedSource.role}` : ''}
              </p>
              <p className={`mt-1 text-xs ${statusLine(selectedSource).tone}`}>
                {statusLine(selectedSource).text}
              </p>
            </div>

            <section
              aria-label="Source administration"
              className="space-y-2 rounded-xl border border-[var(--wallet-border)] wallet-surface-strong p-3"
            >
              <p className="text-xs font-semibold wallet-text-strong">
                Administration
              </p>
              <label className="block text-xs wallet-muted">
                <span className="font-semibold wallet-text-strong">
                  Availability
                </span>
                <select
                  className="wallet-input mt-1.5 w-full rounded-md px-3 py-2 text-sm wallet-text-strong"
                  value={selectedSource.disposition}
                  disabled={busy}
                  onChange={(event) =>
                    void run(() =>
                      setChainSourceDisposition(
                        selectedSource.id,
                        event.target.value as ChainSource['disposition'],
                        view.network
                      )
                    )
                  }
                >
                  <option value="enabled">Enabled</option>
                  <option value="disabled">Disabled</option>
                  <option value="banned">Banned</option>
                </select>
              </label>
              {selectedSource.can_remove &&
              selectedSource.origin !== 'bootstrap' ? (
                <button
                  type="button"
                  disabled={busy}
                  className="text-xs text-red-400/80 hover:text-red-400"
                  onClick={() =>
                    void run(() =>
                      removeChainSource(selectedSource.id, view.network)
                    )
                  }
                >
                  Remove this user source
                </button>
              ) : (
                <p className="text-[11px] wallet-muted">
                  This maintained source can be disabled or banned, but it
                  cannot be removed.
                </p>
              )}
            </section>

            {selectedSource.can_remove &&
              selectedSource.origin !== 'bootstrap' &&
              (showAdd ? (
                serviceForm
              ) : (
                <button
                  type="button"
                  className="wallet-btn-secondary px-3 py-2"
                  onClick={() => {
                    setExtendingSource(selectedSource);
                    setHost(selectedSource.endpoints[0]?.host ?? '');
                    setLabel(selectedSource.label);
                    setOwnInfrastructure(
                      selectedSource.origin === 'own-infrastructure'
                    );
                    setServices({});
                    setServiceStep(true);
                    setShowAdd(true);
                  }}
                >
                  Add services
                </button>
              ))}

            <section aria-label="Configured endpoints" className="space-y-1">
              <p className="text-xs font-semibold wallet-text-strong">
                Configured endpoints
              </p>
              {selectedSource.endpoints.map((endpoint) => (
                <p
                  key={endpointText(endpoint)}
                  className="font-mono text-xs wallet-muted"
                >
                  {endpointText(endpoint)}
                </p>
              ))}
            </section>

            <section
              aria-label="Capabilities and evidence"
              className="space-y-2"
            >
              <div>
                <p className="text-xs font-semibold wallet-text-strong">
                  Catalog capability details
                </p>
                <p className="text-[11px] wallet-muted">
                  Catalog claims describe services listed for this source; they
                  do not confirm a live connection.
                </p>
              </div>
              {(selectedSource.capability_details ?? []).length === 0 ? (
                <p className="text-xs wallet-muted">
                  No catalog capability details recorded.
                </p>
              ) : (
                (selectedSource.capability_details ?? []).map((capability) => (
                  <p
                    key={`${capability.name}:${capability.discovery}`}
                    className="text-xs wallet-muted"
                  >
                    {capability.name} · {confidenceText(capability.confidence)}{' '}
                    · {capability.discovery}
                  </p>
                ))
              )}
            </section>

            <section aria-label="Recorded backend claims" className="space-y-2">
              <div>
                <p className="text-xs font-semibold wallet-text-strong">
                  Recorded backend claims
                </p>
                <p className="text-[11px] wallet-muted">
                  Recorded service claims are separate from the routes currently
                  available to the wallet.
                </p>
              </div>
              {(selectedSource.registered_capability_details ?? []).length ===
              0 ? (
                <p className="text-xs wallet-muted">
                  No registered backend claims recorded.
                </p>
              ) : (
                (selectedSource.registered_capability_details ?? []).map(
                  (claim) => (
                    <p
                      key={`${claim.name}:${claim.protocol}:${claim.discovery}`}
                      className="text-xs wallet-muted"
                    >
                      {claim.name} · {claim.protocol} ·{' '}
                      {confidenceText(claim.confidence)} · {claim.discovery}
                      {claim.endpoint
                        ? ` · ${endpointText(claim.endpoint)}`
                        : ''}
                    </p>
                  )
                )
              )}
            </section>

            <section aria-label="Protocol statuses" className="space-y-2">
              <div>
                <p className="text-xs font-semibold wallet-text-strong">
                  Endpoint protocol status
                </p>
                <p className="text-[11px] wallet-muted">
                  These statuses are recorded for the configured endpoints.
                  Opening this page does not test them.
                </p>
              </div>
              {(selectedSource.protocol_statuses ?? []).length === 0 ? (
                <p className="text-xs wallet-muted">
                  No endpoint protocol statuses recorded.
                </p>
              ) : (
                (selectedSource.protocol_statuses ?? []).map((status) => (
                  <p
                    key={`${status.protocol}:${endpointText(status.endpoint)}`}
                    className="text-xs wallet-muted"
                  >
                    {status.protocol} · {confidenceText(status.status)} ·{' '}
                    {endpointText(status.endpoint)}
                  </p>
                ))
              )}
            </section>

            {selectedSource.failures.length > 0 && (
              <section aria-label="Route diagnostics" className="space-y-1">
                <p className="text-xs font-semibold wallet-text-strong">
                  Route diagnostics
                </p>
                {selectedSource.failures.map((failure) => (
                  <p
                    key={`${failure.protocol}:${endpointText(failure.endpoint)}`}
                    className="text-xs text-amber-400"
                  >
                    {failure.protocol} · {failure.error}
                  </p>
                ))}
              </section>
            )}

            <button
              type="button"
              className="wallet-btn-secondary w-full py-2 text-sm"
              onClick={() => navigate('routing')}
            >
              Configure routing
            </button>
          </div>
        ) : (
          <p className="text-xs wallet-muted">
            This source is no longer present in the Rust catalog.
          </p>
        ))}

      {page === 'explorer' && (
        <div className="space-y-2 rounded-xl border border-[var(--wallet-border)] wallet-surface-strong p-3">
          <p className="text-xs font-semibold wallet-text-strong">
            Explorer links follow the current network policy
          </p>
          <p className="text-xs wallet-muted">
            Choose the explorer and custom link formats used by this wallet.
          </p>
          <p className="text-[11px] wallet-muted">
            Current routing: {CHAIN_POLICY_LABELS[view.policy]}
          </p>
          {explorerSettings ?? (
            <p className="text-xs wallet-muted">
              Explorer settings are unavailable right now.
            </p>
          )}
        </div>
      )}

      {error && (
        <p role="alert" className="text-xs text-red-400">
          {error}
        </p>
      )}
      {refreshError && (
        <p role="alert" className="text-xs text-red-400">
          {refreshError}
        </p>
      )}
    </SectionCard>
  );
}

export default ChainSourcesSettings;
