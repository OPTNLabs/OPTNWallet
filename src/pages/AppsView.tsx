import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import AddonsRegistry from '../services/AddonsRegistry';
import type { AddonAppDefinition, AddonManifest } from '../types/addons';
import PageHeader from '../components/ui/PageHeader';
import SectionCard from '../components/ui/SectionCard';
import SectionHeader from '../components/ui/SectionHeader';
import ActionTile from '../components/ui/ActionTile';
import SegmentedSubnav from '../components/ui/SegmentedSubnav';
import TokenAvatar from '../components/ui/TokenAvatar';
import WalletScreen from '../components/ui/WalletScreen';
import { isComingSoonApp } from './apps/appsViewHelpers';

type AppCard = {
  id: string;
  name: string;
  icon: string;
  description: string;
  category: 'Wallet Tools' | 'Basics' | 'Token Tools' | 'Advanced Apps' | 'Utilities';
  disabled?: boolean;
};

type Filter = 'All' | AppCard['category'];

const DEFAULT_ICON = '/assets/images/OPTNWelcome1.png';

function normalizeAppKey(value: string): string {
  return value.trim().toLowerCase();
}

function getAppCategory(app: Pick<AppCard, 'id' | 'name'>): AppCard['category'] {
  const normalizedId = normalizeAppKey(app.id);
  const normalizedName = normalizeAppKey(app.name);
  if (normalizedId.endsWith(':contractview') || normalizedName === 'contracts') {
    return 'Wallet Tools';
  }
  if (
    normalizedId.endsWith(':paperwalletsweepapp') ||
    normalizedName === 'paper wallet' ||
    normalizedName.includes('walletconnect')
  ) {
    return 'Basics';
  }
  if (normalizedId.endsWith(':mintcashtokenspocapp') || normalizedName === 'mint tokens') {
    return 'Token Tools';
  }
  if (normalizedId.endsWith(':cauldronswapapp') || normalizedName === 'cauldron') {
    return 'Advanced Apps';
  }
  return 'Utilities';
}

function getAppSortPriority(app: Pick<AppCard, 'id' | 'name'>): number {
  const normalizedId = normalizeAppKey(app.id);
  const normalizedName = normalizeAppKey(app.name);
  if (normalizedId.endsWith(':contracts') || normalizedName === 'contracts') return 0;
  if (normalizedId.endsWith(':mintcashtokenspocapp') || normalizedName === 'mint tokens') return 0;
  if (normalizedId.endsWith(':paperwalletsweepapp') || normalizedName === 'paper wallet') return 1;
  if (normalizedId.endsWith(':cauldronswapapp') || normalizedName === 'cauldron') return 2;
  if (normalizedId.endsWith(':eventrewardsapp') || normalizedName === 'airdrops') return 3;
  if (normalizedId.endsWith(':fundmeapp') || normalizedName === 'fundme') return 4;
  return 10;
}

function getAppDescription(app: Pick<AppCard, 'id' | 'name' | 'description'>) {
  const normalizedId = normalizeAppKey(app.id);
  const normalizedName = normalizeAppKey(app.name);
  if (normalizedId.endsWith(':cauldronswapapp') || normalizedName === 'cauldron') {
    return 'Swap BCH and CashTokens';
  }
  return app.description;
}

function getAppIconFrame(app: Pick<AppCard, 'id' | 'name'>): string {
  const normalized = normalizeAppKey(app.name);
  if (normalized.includes('walletconnect')) return 'bg-sky-500/15 text-sky-300';
  if (normalized.includes('paper wallet')) return 'bg-amber-500/15 text-amber-300';
  if (normalized.includes('cauldron')) return 'bg-violet-500/15 text-violet-300';
  if (normalized.includes('mint')) return 'bg-emerald-500/15 text-emerald-300';
  if (normalized.includes('fundme')) return 'bg-rose-500/15 text-rose-300';
  return 'bg-[color-mix(in_oklab,var(--wallet-accent-soft)_70%,transparent)] text-[var(--wallet-accent-strong)]';
}

function shouldHideApp(appId: string, appName: string): boolean {
  const normalizedId = appId.toLowerCase();
  const normalizedName = appName.toLowerCase();
  return normalizedId.endsWith(':authguard') || normalizedName === 'authguard';
}

const FILTERS: Filter[] = ['All', 'Wallet Tools', 'Basics', 'Token Tools', 'Utilities', 'Advanced Apps'];

const AppsView = () => {
  const navigate = useNavigate();
  const [cards, setCards] = useState<AppCard[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('All');

  useEffect(() => {
    let mounted = true;

    (async () => {
      try {
        setError(null);
        const reg = AddonsRegistry();
        await reg.init();
        const manifests: AddonManifest[] = reg.getAddons();
        const out: AppCard[] = [];

        for (const m of manifests) {
          for (const a of (m.apps ?? []) as AddonAppDefinition[]) {
            out.push({
              id: `${m.id}:${a.id}`,
              name: a.name,
              icon: (a.iconUri || m.iconUri || DEFAULT_ICON) as string,
              description: a.description || '',
              category: getAppCategory({ id: `${m.id}:${a.id}`, name: a.name }),
              disabled: isComingSoonApp(`${m.id}:${a.id}`, a.name),
            });
          }
        }

        out.push({
          id: 'optn.wallet.contracts',
          name: 'Contracts',
          icon: DEFAULT_ICON,
          description: 'Browse artifacts and manage deployed instances',
          category: 'Wallet Tools',
        });

        if (mounted) {
          setCards(
            out
              .filter((app) => !shouldHideApp(app.id, app.name))
              .sort((left, right) => {
                const categoryDelta = left.category.localeCompare(right.category);
                if (categoryDelta !== 0) return categoryDelta;
                const priorityDelta = getAppSortPriority(left) - getAppSortPriority(right);
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

  const filteredCards = useMemo(
    () => (filter === 'All' ? cards : cards.filter((card) => card.category === filter)),
    [cards, filter]
  );

  return (
    <WalletScreen maxWidthClassName="max-w-md">
      <div className="flex h-full min-h-0 flex-col gap-4">
        <PageHeader title="Apps" subtitle="Extend your wallet with tools" compact />

        <SectionCard className="p-3">
          <SectionHeader title="Browse apps" subtitle="Filter by category" compact />
          <SegmentedSubnav
            value={filter}
            onChange={setFilter}
            options={FILTERS.map((value) => ({
              value,
              label:
                value === 'Wallet Tools'
                  ? 'Wallet'
                  : value === 'Token Tools'
                    ? 'Tokens'
                    : value === 'Advanced Apps'
                      ? 'Advanced'
                      : value === 'Utilities'
                        ? 'Utils'
                        : value,
            }))}
          />
        </SectionCard>

        {error && (
          <div className="rounded border wallet-danger-panel p-3 text-sm">
            Failed to load addon apps: {error}
          </div>
        )}

        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain pr-1 space-y-3">
          <div className="grid grid-cols-2 gap-2.5">
            {filteredCards.length > 0 ? (
              filteredCards.map((app) => (
                <ActionTile
                  key={app.id}
                  compact
                  title={app.name}
                  description={getAppDescription(app)}
                  disabled={app.disabled}
                  onClick={
                    app.disabled
                      ? undefined
                      : () => {
                          if (app.id === 'optn.wallet.contracts') {
                            navigate('/contract');
                            return;
                          }
                          if (app.id === 'optn.builtin.paper-wallet-sweep:paperWalletSweepApp') {
                            navigate('/paper-wallet-sweep');
                            return;
                          }
                          navigate(`/apps/${app.id}`);
                        }
                  }
                  icon={
                    <div className={`flex h-8 w-8 items-center justify-center rounded-2xl ${getAppIconFrame(app)}`}>
                      <TokenAvatar iconUri={app.icon} name={app.name} sizeClassName="h-8 w-8" />
                    </div>
                  }
                />
              ))
            ) : (
              <div className="col-span-2 rounded-2xl border border-[var(--wallet-border)] p-4 text-sm wallet-muted">
                No apps in this category.
              </div>
            )}
          </div>
        </div>
      </div>
    </WalletScreen>
  );
};

export default AppsView;
