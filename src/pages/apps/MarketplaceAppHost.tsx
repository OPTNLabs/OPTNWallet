// src/pages/apps/MarketplaceAppHost.tsx

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useSelector } from 'react-redux';

import { RootState } from '../../redux/store';
import AddonsRegistry from '../../services/AddonsRegistry';
import { getAddonGrantedCapabilities } from '../../services/AddonsAllowlist';
import KeyService from '../../services/KeyService';

import type {
  AddonManifest,
  AddonAppDefinition,
  AddonCapability,
} from '../../types/addons';
import { createAddonSDK, type AddonSDK } from '../../services/AddonsSDK';
import { renderDeclarativeScreen } from './marketplaceScreenResolver';

type ResolvedApp = {
  manifest: AddonManifest;
  app: AddonAppDefinition;
};

type PromptDecision = 'allow-once' | 'allow-always' | 'deny';
type ConsentPrompt = {
  mode: 'launch' | 'runtime';
  title: string;
  message: string;
  appKey: string;
  capability?: AddonCapability;
  capabilities?: AddonCapability[];
};
type PersistedConsent = Record<string, Record<string, true>>;

const CONSENT_STORAGE_KEY = 'optn.addon.consent.v1';
const SENSITIVE_RUNTIME_CAPABILITIES = new Set<AddonCapability>([
  'tx:broadcast',
  'signing:message_sign',
  'signing:signature_template',
]);

function isTrustedAddon(manifest: AddonManifest): boolean {
  return manifest.trustTier === 'internal';
}

function readPersistedConsent(): PersistedConsent {
  try {
    const raw = localStorage.getItem(CONSENT_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed as PersistedConsent;
  } catch {
    return {};
  }
}

function writePersistedConsent(next: PersistedConsent): void {
  try {
    localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // best-effort persistence
  }
}

function formatCapability(capability: AddonCapability): string {
  switch (capability) {
    case 'wallet:context:read':
      return 'Read wallet context';
    case 'wallet:addresses:read':
      return 'Read wallet addresses';
    case 'utxo:wallet:read':
      return 'Read wallet UTXOs';
    case 'utxo:address:read':
      return 'Read UTXOs for wallet addresses';
    case 'utxo:address:refresh':
      return 'Refresh and store UTXOs for wallet addresses';
    case 'bcmr:token:read':
      return 'Read CashToken metadata';
    case 'tokenindex:holders:read':
      return 'Read TokenIndex holder lists';
    case 'tx:build':
      return 'Build transactions';
    case 'tx:add_output':
      return 'Construct transaction outputs';
    case 'tx:broadcast':
      return 'Broadcast transactions';
    case 'signing:message_sign':
      return 'Sign messages with wallet keys';
    case 'signing:signature_template':
      return 'Create signature templates';
    case 'http:fetch_json':
      return 'Fetch JSON over HTTP';
    default:
      return capability;
  }
}

function parseAppKey(appIdParam: string | undefined): {
  addonId?: string;
  appId?: string;
} {
  const raw = (appIdParam ?? '').trim();
  if (!raw) return {};
  // supported:
  // - "authguard" (global search)
  // - "<addonId>:<appId>" (preferred)
  if (raw.includes(':')) {
    const [addonId, ...rest] = raw.split(':').filter(Boolean);
    const appId = rest.join(':');
    return { addonId, appId };
  }
  return { appId: raw };
}

function getDeclarativeScreenId(app: AddonAppDefinition): string {
  // v1: map declarative apps by config.screen (preferred), else fall back to app.id
  const cfg: any = (app as any)?.config ?? null;
  const screen = typeof cfg?.screen === 'string' ? cfg.screen.trim() : '';
  return screen || app.id;
}

function isDisabledApp(app: AddonAppDefinition): boolean {
  const screenId = getDeclarativeScreenId(app).toLowerCase();
  const appId = app.id.toLowerCase();
  const appName = app.name.toLowerCase();

  return (
    screenId === 'authguard' ||
    screenId === 'authguardapp' ||
    appId === 'authguard' ||
    appName === 'authguard'
  );
}

export default function MarketplaceAppHost() {
  const navigate = useNavigate();
  const { appId: appIdParam } = useParams();

  const walletId = useSelector(
    (state: RootState) => state.wallet_id.currentWalletId
  );
  const network = useSelector((state: RootState) => state.network.currentNetwork);

  const [loading, setLoading] = useState(true);
  const [resolved, setResolved] = useState<ResolvedApp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [launchApproved, setLaunchApproved] = useState(false);

  // optional hardening: preload addresses once per wallet
  const [walletAddresses, setWalletAddresses] = useState<Set<string> | null>(
    null
  );
  const [persistedConsent, setPersistedConsent] = useState<PersistedConsent>(
    () => readPersistedConsent()
  );
  const [consentPrompt, setConsentPrompt] = useState<ConsentPrompt | null>(
    null
  );
  const promptOpenRef = useRef(false);
  const promptQueueRef = useRef<
    Array<{ prompt: ConsentPrompt; resolve: (decision: PromptDecision) => void }>
  >([]);
  const activeResolverRef = useRef<((decision: PromptDecision) => void) | null>(
    null
  );

  const parsed = useMemo(() => parseAppKey(appIdParam), [appIdParam]);
  const trustedAddon = useMemo(
    () => (resolved ? isTrustedAddon(resolved.manifest) : false),
    [resolved]
  );
  const appConsentKey = useMemo(() => {
    if (!resolved || !walletId) return '';
    return `${walletId}:${resolved.manifest.id}:${resolved.app.id}`;
  }, [resolved, walletId]);

  const hasPersistedCapabilityGrant = useCallback(
    (appKey: string, capability: AddonCapability) =>
      Boolean(persistedConsent[appKey]?.[capability]),
    [persistedConsent]
  );

  const persistCapabilityGrant = useCallback(
    (appKey: string, capability: AddonCapability) => {
      setPersistedConsent((prev) => {
        const existing = prev[appKey] ?? {};
        if (existing[capability]) return prev;
        const next: PersistedConsent = {
          ...prev,
          [appKey]: {
            ...existing,
            [capability]: true,
          },
        };
        writePersistedConsent(next);
        return next;
      });
    },
    []
  );

  const showPrompt = useCallback(
    (entry: {
      prompt: ConsentPrompt;
      resolve: (decision: PromptDecision) => void;
    }) => {
      promptOpenRef.current = true;
      setConsentPrompt(entry.prompt);

      activeResolverRef.current = (decision: PromptDecision) => {
        entry.resolve(decision);
        setConsentPrompt(null);

        const next = promptQueueRef.current.shift();
        if (next) {
          showPrompt(next);
          return;
        }

        promptOpenRef.current = false;
        activeResolverRef.current = null;
      };
    },
    []
  );

  const requestPrompt = useCallback(
    (prompt: ConsentPrompt): Promise<PromptDecision> =>
      new Promise((resolve) => {
        const entry = { prompt, resolve };
        if (!promptOpenRef.current) {
          showPrompt(entry);
          return;
        }
        promptQueueRef.current.push(entry);
      }),
    [showPrompt]
  );

  const resolvePrompt = useCallback((decision: PromptDecision) => {
    activeResolverRef.current?.(decision);
  }, []);

  useEffect(() => {
    let mounted = true;

    (async () => {
      try {
        setLoading(true);
        setError(null);

        const addons = AddonsRegistry();
        await addons.init();

        const manifests = addons.getAddons();
        let found: ResolvedApp | null = null;

        if (parsed.addonId && parsed.appId) {
          const m = manifests.find((x) => x.id === parsed.addonId);
          const app = m?.apps?.find((a) => a.id === parsed.appId);
          if (m && app) found = { manifest: m, app };
        } else if (parsed.appId) {
          for (const m of manifests) {
            const app = m.apps?.find((a) => a.id === parsed.appId);
            if (app) {
              found = { manifest: m, app };
              break;
            }
          }
        }

        if (!found) {
          throw new Error(`App not found: ${appIdParam ?? ''}`);
        }

        if (mounted) setResolved(found);
      } catch (e: any) {
        if (mounted) setError(e?.message ?? String(e));
      } finally {
        if (mounted) setLoading(false);
      }
    })();

    return () => {
      mounted = false;
    };
  }, [appIdParam, parsed.addonId, parsed.appId]);

  useEffect(() => {
    setLaunchApproved(false);
  }, [appConsentKey]);

  // preload wallet addresses for SDK hardening (best-effort)
  useEffect(() => {
    let mounted = true;

    (async () => {
      try {
        if (!walletId) {
          if (mounted) setWalletAddresses(null);
          return;
        }
        const keys = await KeyService.retrieveKeys(walletId);
        const set = new Set<string>(
          keys.map((k: any) => k.address).filter(Boolean)
        );
        if (mounted) setWalletAddresses(set);
      } catch {
        // best-effort; address-scoped SDK methods will fail closed if allowlist is unavailable
        if (mounted) setWalletAddresses(null);
      }
    })();

    return () => {
      mounted = false;
    };
  }, [walletId]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        if (!resolved || !walletId) {
          if (!cancelled) setLaunchApproved(false);
          return;
        }

        if (isTrustedAddon(resolved.manifest)) {
          if (!cancelled) setLaunchApproved(true);
          return;
        }

        const appKey = `${walletId}:${resolved.manifest.id}:${resolved.app.id}`;
        const requestedCaps = (
          resolved.app.requiredCapabilities?.length
            ? resolved.app.requiredCapabilities
            : Array.from(getAddonGrantedCapabilities(resolved.manifest))
        ).filter(Boolean);

        if (requestedCaps.length === 0) {
          if (!cancelled) setLaunchApproved(true);
          return;
        }

        const ungranted = requestedCaps.filter(
          (cap) => !hasPersistedCapabilityGrant(appKey, cap)
        );

        if (ungranted.length === 0) {
          if (!cancelled) setLaunchApproved(true);
          return;
        }

        const decision = await requestPrompt({
          mode: 'launch',
          appKey,
          capabilities: ungranted,
          title: `Allow ${resolved.app.name} capabilities?`,
          message:
            'This addon app is requesting wallet capabilities before launch.',
        });

        if (cancelled) return;

        if (decision === 'deny') {
          setError('Permission denied. App launch was blocked.');
          setLaunchApproved(false);
          return;
        }

        if (decision === 'allow-always') {
          for (const cap of ungranted) {
            persistCapabilityGrant(appKey, cap);
          }
        }

        setLaunchApproved(true);
      } catch (e: any) {
        if (cancelled) return;
        setError(e?.message ?? String(e));
        setLaunchApproved(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    hasPersistedCapabilityGrant,
    persistCapabilityGrant,
    requestPrompt,
    resolved,
    walletId,
  ]);

  const authorizeCapability = useCallback(
    async ({
      capability,
      addonId,
    }: {
      capability: AddonCapability;
      addonId: string;
    }) => {
      if (!resolved || !walletId) {
        throw new Error('Missing addon runtime context');
      }

      if (addonId !== resolved.manifest.id) {
        throw new Error('Addon context mismatch while authorizing capability');
      }

      if (isTrustedAddon(resolved.manifest)) return;
      if (!SENSITIVE_RUNTIME_CAPABILITIES.has(capability)) return;

      const appKey = `${walletId}:${resolved.manifest.id}:${resolved.app.id}`;
      if (hasPersistedCapabilityGrant(appKey, capability)) return;

      const decision = await requestPrompt({
        mode: 'runtime',
        appKey,
        capability,
        title: `Allow sensitive action?`,
        message: `${resolved.app.name} requested: ${formatCapability(capability)}.`,
      });

      if (decision === 'deny') {
        throw new Error(`User denied addon permission: ${capability}`);
      }

      if (decision === 'allow-always') {
        persistCapabilityGrant(appKey, capability);
      }
    },
    [
      hasPersistedCapabilityGrant,
      persistCapabilityGrant,
      requestPrompt,
      resolved,
      walletId,
    ]
  );

  const sdk: AddonSDK | null = useMemo(() => {
    if (!resolved || !walletId) return null;
    if (!trustedAddon && !launchApproved) return null;

    return createAddonSDK(resolved.manifest, {
      walletId,
      network,
      walletAddresses: walletAddresses ?? undefined,
      allowedCapabilities: resolved.app.requiredCapabilities
        ? new Set(resolved.app.requiredCapabilities)
        : undefined,
      authorizeCapability: trustedAddon ? undefined : authorizeCapability,
    });
  }, [
    authorizeCapability,
    launchApproved,
    resolved,
    trustedAddon,
    walletAddresses,
    walletId,
    network,
  ]);

  const loadWalletAddresses = async () => {
    if (!walletId) return new Set<string>();
    // if already loaded, reuse
    if (walletAddresses) return walletAddresses;

    const keys = await KeyService.retrieveKeys(walletId);
    return new Set<string>(keys.map((k: any) => k.address).filter(Boolean));
  };

  // Patient-0: map declarative app => local component
  const renderApp = () => {
    if (!resolved || !sdk) return null;

    if (resolved.app.kind !== 'declarative') {
      return (
        <div className="p-4">
          <div className="font-bold">Unsupported app kind:</div>
          <pre className="text-sm">{String((resolved.app as any).kind)}</pre>
        </div>
      );
    }

    const screenId = getDeclarativeScreenId(resolved.app);

    const rendered = renderDeclarativeScreen({
      screenId,
      resolved,
      sdk,
      loadWalletAddresses,
    });
    if (rendered) return rendered;

    return (
      <div className="p-4">
        <div className="font-bold">Unsupported declarative app:</div>
        <div className="text-sm text-gray-700 mt-1">
          Expected config.screen (or app.id) to map to a built-in app
          implementation.
        </div>
        <div className="mt-3 text-sm">
          <div className="font-semibold">Resolved screenId</div>
          <pre className="text-xs bg-gray-100 p-2 rounded">
            {String(screenId)}
          </pre>

          <div className="font-semibold mt-3">App definition</div>
          <pre className="text-xs bg-gray-100 p-2 rounded overflow-x-auto">
            {JSON.stringify(resolved.app, null, 2)}
          </pre>
        </div>
      </div>
    );
  };

  if (loading) {
    return (
      <div className="container mx-auto p-4">
        <div className="text-lg font-semibold">Loading app…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="container mx-auto p-4">
        <div className="text-lg font-semibold text-red-600">
          Failed to load app
        </div>
        <div className="mt-2 text-sm text-gray-700">{error}</div>

        <button
          onClick={() => navigate('/apps')}
          className="mt-4 bg-blue-500 hover:bg-blue-600 text-white py-2 px-4 rounded"
        >
          Back to Apps
        </button>
      </div>
    );
  }

  if (!walletId) {
    return (
      <div className="container mx-auto p-4">
        <div className="text-lg font-semibold">No wallet selected</div>
        <button
          onClick={() => navigate('/landing')}
          className="mt-4 bg-blue-500 hover:bg-blue-600 text-white py-2 px-4 rounded"
        >
          Go to Landing
        </button>
      </div>
    );
  }

  if (resolved && isDisabledApp(resolved.app)) {
    return (
      <div className="container mx-auto p-4">
        <div className="text-lg font-semibold">{resolved.app.name}</div>
        <div className="mt-2 wallet-muted">Coming soon.</div>
        <button
          onClick={() => navigate('/apps')}
          className="wallet-btn-secondary mt-4"
        >
          Back to Apps
        </button>
      </div>
    );
  }

  if (!trustedAddon && !launchApproved) {
    return (
      <div className="container mx-auto p-4">
        <div className="text-lg font-semibold">Waiting for app permission</div>
        <div className="mt-2 text-sm wallet-muted">
          Approve required capabilities to continue.
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="mx-auto flex h-screen w-full max-w-md flex-col overflow-hidden px-4 pb-16">
        <div className="flex-1 min-h-0 overflow-hidden">
          {renderApp()}
        </div>
      </div>
      {consentPrompt && (
        <div className="wallet-popup-backdrop">
          <div className="wallet-popup-panel max-w-lg">
            <div className="text-lg font-semibold">{consentPrompt.title}</div>
            <div className="mt-2 text-sm wallet-muted">{consentPrompt.message}</div>

            {consentPrompt.mode === 'launch' &&
              Array.isArray(consentPrompt.capabilities) &&
              consentPrompt.capabilities.length > 0 && (
                <ul className="mt-3 space-y-1 text-sm">
                  {consentPrompt.capabilities.map((cap) => (
                    <li key={cap}>• {formatCapability(cap)}</li>
                  ))}
                </ul>
              )}

            {consentPrompt.mode === 'runtime' && consentPrompt.capability && (
              <div className="mt-3 text-sm">
                Capability: {formatCapability(consentPrompt.capability)}
              </div>
            )}

            <div className="mt-5 flex flex-wrap gap-2">
              <button
                type="button"
                className="wallet-btn-danger"
                onClick={() => resolvePrompt('deny')}
              >
                Deny
              </button>
              <button
                type="button"
                className="wallet-btn-secondary"
                onClick={() => resolvePrompt('allow-once')}
              >
                Allow once
              </button>
              <button
                type="button"
                className="wallet-btn-primary"
                onClick={() => resolvePrompt('allow-always')}
              >
                Always allow
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
