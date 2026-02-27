// src/pages/apps/MarketplaceAppHost.tsx

import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useSelector } from 'react-redux';

import { RootState } from '../../redux/store';
import AddonsRegistry from '../../services/AddonsRegistry';
import KeyService from '../../services/KeyService';

import type { AddonManifest, AddonAppDefinition } from '../../types/addons';
import { createAddonSDK, type AddonSDK } from '../../services/AddonsSDK';

import AuthGuardApp from './patient0/AuthGuardApp';
import MintCashTokensPoCApp from './mint-cashtokens-poc/MintCashTokensPoCApp';

type ResolvedApp = {
  manifest: AddonManifest;
  app: AddonAppDefinition;
};

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

export default function MarketplaceAppHost() {
  const navigate = useNavigate();
  const { appId: appIdParam } = useParams();

  const walletId = useSelector(
    (state: RootState) => state.wallet_id.currentWalletId
  );

  const [loading, setLoading] = useState(true);
  const [resolved, setResolved] = useState<ResolvedApp | null>(null);
  const [error, setError] = useState<string | null>(null);

  // optional hardening: preload addresses once per wallet
  const [walletAddresses, setWalletAddresses] = useState<Set<string> | null>(
    null
  );

  const parsed = useMemo(() => parseAppKey(appIdParam), [appIdParam]);

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
        // best-effort; if this fails we still allow SDK without address restriction
        if (mounted) setWalletAddresses(null);
      }
    })();

    return () => {
      mounted = false;
    };
  }, [walletId]);

  const sdk: AddonSDK | null = useMemo(() => {
    if (!resolved || !walletId) return null;

    return createAddonSDK(resolved.manifest, {
      walletId,
      walletAddresses: walletAddresses ?? undefined,
    });
  }, [resolved, walletId, walletAddresses]);

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

    switch (screenId) {
      case 'authguard':
      case 'AuthGuard':
      case 'AuthGuardApp':
        return (
          <AuthGuardApp
            manifest={resolved.manifest}
            app={resolved.app}
            sdk={sdk}
            loadWalletAddresses={loadWalletAddresses}
          />
        );

      case 'MintCashTokensPoCApp':
      case 'mintCashTokensPoCApp':
        return <MintCashTokensPoCApp />;

      default:
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
    }
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

  return (
    <div className="container mx-auto p-4 pb-16 h-screen flex flex-col">
      <div className="flex items-center justify-between mb-4 flex-none">
        {/* <div>
          <div className="text-xl font-bold">{resolved?.app.name}</div>
          <div className="text-sm text-gray-600">
            {resolved?.app.description}
          </div>
        </div> */}

        <button
          onClick={() => navigate('/apps')}
          className="bg-gray-200 hover:bg-gray-300 text-gray-900 py-2 px-4 rounded"
        >
          Back
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
        {renderApp()}
      </div>
    </div>
  );
}
