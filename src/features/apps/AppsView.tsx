import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSelector } from 'react-redux';
import { MdChatBubbleOutline } from 'react-icons/md';
import AddonsRegistry from '../../services/AddonsRegistry';
import type { AddonAppDefinition, AddonManifest } from '../../types/addons';
import PageHeader from '../../components/ui/PageHeader';
import SectionCard from '../../components/ui/SectionCard';
import SectionHeader from '../../components/ui/SectionHeader';
import ActionTile from '../../components/ui/ActionTile';
import SegmentedSubnav from '../../components/ui/SegmentedSubnav';
import TokenAvatar from '../../components/ui/TokenAvatar';
import WalletScreen from '../../components/ui/WalletScreen';
import {
  type AppsViewCategory,
  compareAppsForBrowse,
  getAppCategory,
  getAppDescription,
  getAppIconFrame,
  isDesktopOnlyApp,
  isComingSoonApp,
  shouldHideApp,
} from './appsViewHelpers';
import { Capacitor } from '@capacitor/core';
import { isDesktopPlatform } from '../../utils/platform';
import { selectNostrChatEnabled } from '../../state/slices/experimentalSlice';

type AppCard = {
  id: string;
  name: string;
  icon: string;
  description: string;
  category: AppsViewCategory;
  comingSoon?: boolean;
  disabled?: boolean;
};

type Filter = 'All' | AppCard['category'];

const DEFAULT_ICON = '/assets/images/OPTNWelcome1.png';

const FILTERS: Filter[] = ['All', 'Wallet', 'Token', 'Utils', 'Advanced'];

const AppsView = () => {
  const navigate = useNavigate();
  const devMode = import.meta.env.DEV;
  const isNativeRuntime = Capacitor.isNativePlatform();
  const isDesktopRuntime = isDesktopPlatform();
  const chatEnabled = useSelector(selectNostrChatEnabled);
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
            const appId = `${m.id}:${a.id}`;
            const appName = a.name;
            const comingSoon = isComingSoonApp(appId, appName);
            const normalizedName = appName.toLowerCase();
            const resolvedIcon =
              normalizedName === 'airdrops'
                ? '/assets/images/OPTNUIkeyline2.png'
                : (a.iconUri || m.iconUri || DEFAULT_ICON);
            out.push({
              id: appId,
              name: appName,
              icon: resolvedIcon as string,
              description: a.description || '',
              category: getAppCategory({ id: appId, name: appName }),
              comingSoon,
              disabled: comingSoon && !devMode,
            });
          }
        }

        out.push({
          id: 'optn.wallet.contracts',
          name: 'Contracts',
          icon: '/assets/images/OPTNUIkeyline2.png',
          description: 'Browse artifacts and manage deployed instances',
          category: 'Wallet',
        });

        out.push({
          id: 'optn.wallet.quantumroot',
          name: 'Quantumroot',
          icon: '/assets/images/OPTNUIkeyline2.png',
          description: 'Receive and recovery tools for advanced vaults',
          category: 'Wallet',
        });

        const cashFusionApp: AppCard = {
          id: 'optn.wallet.cashfusion',
          name: 'CashFusion',
          icon: '/assets/images/OPTNUIkeyline2.png',
          description: 'Private CoinJoin — server or P2P over Nostr + Tor',
          category: 'Wallet',
        };
        if (isDesktopRuntime || !isDesktopOnlyApp(cashFusionApp.id)) {
          out.push(cashFusionApp);
        }

        if (chatEnabled) {
          out.push({
            id: 'optn.wallet.nostr-chat',
            name: 'Chat',
            icon: DEFAULT_ICON,
            description: 'Private end-to-end encrypted Nostr messaging',
            category: 'Utils',
          });
        }

        if (mounted) {
          setCards(
            out
              .filter((app) => !shouldHideApp(app.id, app.name))
              .sort(compareAppsForBrowse)
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
  }, [chatEnabled, devMode, isDesktopRuntime]);

  const filteredCards = useMemo(
    () => (filter === 'All' ? cards : cards.filter((card) => card.category === filter)),
    [cards, filter]
  );
  return (
    <WalletScreen maxWidthClassName="max-w-md">
      <div className="flex h-full min-h-0 flex-col gap-4">
        <PageHeader title="Apps" subtitle="Extend your wallet with tools" compact />

        <SectionCard className="p-3 wallet-surface-strong">
          <SectionHeader
            title="Browse apps"
            subtitle="Wallet first, then tokens, utils, and advanced platforms"
            compact
          />
          <SegmentedSubnav
            value={filter}
            onChange={setFilter}
            options={FILTERS.map((value) => ({
              value,
              label:
                value === 'Wallet'
                  ? 'Wallet'
                  : value === 'Token'
                    ? 'Token'
                    : value === 'Advanced'
                      ? 'Advanced'
                      : value === 'Utils'
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
          <div className="space-y-2.5">
            {filteredCards.length > 0 ? (
              filteredCards.map((app) => (
                <ActionTile
                  key={app.id}
                  compact
                  title={app.name}
                  description={getAppDescription(app)}
                  layout="horizontal"
                  descriptionLines={2}
                  className="overflow-hidden"
                  style={{ height: '112px' }}
                  disabled={app.disabled || (app.comingSoon && isNativeRuntime && !devMode)}
                  trailing={
                    isComingSoonApp(app.id, app.name) ? (
                      <span className="inline-flex items-center rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-[11px] font-semibold text-amber-200">
                        Coming soon
                      </span>
                    ) : null
                  }
                  onClick={
                    app.disabled
                      ? undefined
                      : () => {
                          if (app.id === 'optn.wallet.contracts') {
                            navigate('/contract', { state: { returnTo: '/apps' } });
                            return;
                          }
                          if (app.id === 'optn.wallet.quantumroot') {
                            navigate('/quantumroot', { state: { returnTo: '/apps' } });
                            return;
                          }
                          if (app.id === 'optn.wallet.cashfusion') {
                            // First-class app route — not Settings (that felt like a UI bug).
                            navigate('/cashfusion', { state: { returnTo: '/apps' } });
                            return;
                          }
                          if (app.id === 'optn.wallet.nostr-chat') {
                            navigate('/chat', { state: { returnTo: '/apps' } });
                            return;
                          }
                          if (app.name.toLowerCase().includes('paryonusd')) {
                            navigate('/paryon', { state: { returnTo: '/apps' } });
                            return;
                          }
                          if (app.id === 'optn.builtin.paper-wallet-sweep:paperWalletSweepApp') {
                            navigate('/paper-wallet-sweep', { state: { returnTo: '/apps' } });
                            return;
                          }
                          navigate(`/apps/${app.id}`, { state: { returnTo: '/apps' } });
                        }
                  }
                  icon={
                    app.id === 'optn.builtin.cauldron:cauldronSwapApp' ||
                    app.id === 'optn.builtin.events:airdropsApp' ||
                    app.id === 'optn.wallet.contracts' ||
                    app.id === 'optn.wallet.quantumroot' ||
                    app.id === 'optn.wallet.cashfusion' ||
                    app.id === 'optn.wallet.nostr-chat' ||
                    app.id === 'optn.builtin.fundme:fundmeApp' ? (
                      <div
                        className={`flex h-8 w-8 items-center justify-center overflow-hidden rounded-2xl border border-[var(--wallet-border)] bg-[color-mix(in_oklab,var(--wallet-surface-strong)_72%,transparent)] ${getAppIconFrame(app)}`}
                      >
                        {app.id === 'optn.wallet.nostr-chat' ? (
                          <MdChatBubbleOutline className="text-xl" aria-hidden="true" />
                        ) : (
                          <img
                            src={app.icon}
                            alt={app.name}
                            className="h-full w-full object-contain p-1"
                          />
                        )}
                      </div>
                    ) : (
                      <div
                        className={`flex h-8 w-8 items-center justify-center rounded-2xl ${getAppIconFrame(app)}`}
                      >
                        <TokenAvatar
                          iconUri={app.icon}
                          name={app.name}
                          sizeClassName="h-8 w-8"
                        />
                      </div>
                    )
                  }
                />
              ))
            ) : (
              <div className="rounded-2xl border border-[var(--wallet-border)] p-4 text-sm wallet-muted">
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
