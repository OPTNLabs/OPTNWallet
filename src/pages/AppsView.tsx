// src/pages/AppsView.tsx

import { useEffect, useState } from 'react';
import { useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import { RootState } from '../redux/store';

import AddonsRegistry from '../services/AddonsRegistry';
import type { AddonAppDefinition, AddonManifest } from '../types/addons';

type AppCard = {
  id: string; // "fundme" OR "<addonId>:<appId>"
  name: string;
  icon: string;
  description: string;
  source: 'builtin' | 'addon';
  disabled?: boolean;
};

const DEFAULT_ICON = '/assets/images/OPTNWelcome1.png';

function normalizeAppKey(value: string): string {
  return value.trim().toLowerCase();
}

function getAppSortPriority(app: Pick<AppCard, 'id' | 'name'>): number {
  const normalizedId = normalizeAppKey(app.id);
  const normalizedName = normalizeAppKey(app.name);

  if (
    normalizedId.endsWith(':mintcashtokenspocapp') ||
    normalizedName === 'mint tokens'
  ) {
    return 0;
  }

  if (
    normalizedId.endsWith(':eventrewardsapp') ||
    normalizedId.endsWith(':airdropsapp') ||
    normalizedName === 'airdrops'
  ) {
    return 1;
  }

  if (
    normalizedId.endsWith(':cauldronswapapp') ||
    normalizedName === 'cauldron'
  ) {
    return 2;
  }

  if (normalizedId.endsWith(':fundmeapp') || normalizedName === 'fundme') {
    return 3;
  }

  return 10;
}

function getAppDescription(app: Pick<AppCard, 'id' | 'name' | 'description'>) {
  const normalizedId = normalizeAppKey(app.id);
  const normalizedName = normalizeAppKey(app.name);

  if (
    normalizedId.endsWith(':cauldronswapapp') ||
    normalizedName === 'cauldron'
  ) {
    return 'Demo showcase: native BCH to token swaps via Cauldron pools';
  }

  if (normalizedId.endsWith(':fundmeapp') || normalizedName === 'fundme') {
    return 'Demo showcase: BCH crowdfunding flows inside OPTN Wallet';
  }

  return app.description;
}

function isComingSoonApp(appId: string, appName: string): boolean {
  const normalizedId = appId.toLowerCase();
  const normalizedName = appName.toLowerCase();
  return (
    normalizedId.endsWith(':authguard') ||
    normalizedName === 'authguard'
  );
}

function shouldHideApp(appId: string, appName: string): boolean {
  const normalizedId = appId.toLowerCase();
  const normalizedName = appName.toLowerCase();
  return (
    normalizedId.endsWith(':authguard') ||
    normalizedName === 'authguard'
  );
}

const AppsView = () => {
  const navigate = useNavigate();
  const wallet_id = useSelector(
    (state: RootState) => state.wallet_id.currentWalletId
  );

  const [cards, setCards] = useState<AppCard[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    (async () => {
      try {
        setError(null);

        const reg = AddonsRegistry();
        await reg.init();
        const manifests: AddonManifest[] = reg.getAddons();

        const out: AppCard[] = [];

        // ✅ Add addon apps
        for (const m of manifests) {
          for (const a of (m.apps ?? []) as AddonAppDefinition[]) {
            out.push({
              id: `${m.id}:${a.id}`,
              name: a.name,
              icon: (a.iconUri || m.iconUri || DEFAULT_ICON) as string,
              description: a.description || '',
              source: 'addon',
              disabled: isComingSoonApp(`${m.id}:${a.id}`, a.name),
            });
          }
        }

        if (mounted) {
          setCards(
            out
              .filter((app) => !shouldHideApp(app.id, app.name))
              .sort((left, right) => {
                const priorityDelta =
                  getAppSortPriority(left) - getAppSortPriority(right);
                if (priorityDelta !== 0) return priorityDelta;
                return left.name.localeCompare(right.name);
              })
          );
        }
      } catch (e: unknown) {
        if (mounted) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    })();

    return () => {
      mounted = false;
    };
  }, []);

  const handleAppClick = (app: AppCard) => {
    if (app.disabled) return;

    const appId = app.id;
    // addon app => /apps/<addonId>:<appId>
    navigate(`/apps/${appId}`);
  };

  return (
    <div className="container mx-auto p-4">
      <div className="flex justify-center mt-4">
        <img
          src="/assets/images/OPTNWelcome1.png"
          alt="Welcome"
          className="w-full max-w-[260px] h-auto object-contain"
        />
      </div>

      <div className="container mx-auto p-4">
        <div className="flex justify-between items-center mb-6">
          <h1 className="text-2xl font-bold">Apps</h1>
          <button
            onClick={() => navigate(`/home/${wallet_id}`)}
            className="wallet-btn-danger py-2 px-4"
          >
            Go Back
          </button>
        </div>

        {error && (
          <div className="mb-4 p-3 rounded border wallet-danger-panel text-sm">
            Failed to load addon apps: {error}
          </div>
        )}

        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {cards.map((app) => (
            <div
              key={app.id}
              onClick={() => handleAppClick(app)}
              className={`wallet-card p-4 rounded-lg transition-shadow ${
                app.disabled
                  ? 'opacity-80 cursor-not-allowed'
                  : 'hover:shadow-md cursor-pointer'
              }`}
            >
              <div className="flex flex-col items-center">
                <img
                  src={app.icon}
                  alt={app.name}
                  className="w-16 h-16 mb-2 object-contain"
                />
                <h3 className="font-semibold text-center">{app.name}</h3>
                <p className="text-sm wallet-muted text-center">
                  {app.disabled ? 'Coming soon' : getAppDescription(app)}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default AppsView;
