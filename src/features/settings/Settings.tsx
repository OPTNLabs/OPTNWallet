import React, { useEffect, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { MdModeNight, MdSunny } from 'react-icons/md';
import WalletManager from '../../apis/WalletManager/WalletManager';
import { resetWallet, setWalletId } from '../../state/slices/walletSlice';
import { resetUTXOs } from '../../state/slices/utxoSlice';
import { resetTransactions } from '../../state/slices/transactionSlice';
import { resetContract } from '../../state/slices/contractSlice';
import { Network, resetNetwork } from '../../state/slices/networkSlice';
import { clearTransaction } from '../../state/slices/transactionBuilderSlice';
import { selectCurrentNetwork } from '../../state/selectors/networkSelectors';
import { NetworkSettings } from './NetworkSettings';
import { DerivationPathSettings } from './DerivationPathSettings';
import { ServerSettings } from './ServerSettings';
import { ConsolePanel } from './ConsolePanel';
import { ExperimentalSettings } from './ExperimentalSettings';
import { CashFusionSettings } from './CashFusionSettings';
import { NostrSettings } from '../nostr/NostrSettings';
import { AddonsSettings } from './AddonsSettings';
import RecoveryPhrase from '../../components/RecoveryPhrase';
import AboutView from '../../components/AboutView';
import TermsOfUse from '../../components/TermsOfUse';
import ContactUs from '../../components/ContactUs';
import FaucetView from '../../components/FaucetView';
import WalletConnectPanel from '../../components/walletconnect/WalletConnectPanel';
import WizardConnectPanel from '../../components/wizardconnect/WizardConnectPanel';
import CashConnectPanel from '../../components/cashconnect/CashConnectPanel';
import { AppLockSettings } from '../../platform/desktop/AppLockSettings';
import { RebuildWalletSettings } from '../../platform/desktop/RebuildWalletSettings';
import { ExportColdArchiveSettings } from '../../platform/desktop/ExportColdArchiveSettings';
import { WalletInfoSettings } from './WalletInfoSettings';

import { disconnectAllWizardConnections } from '../../state/slices/wizardconnectSlice';
import { stopCashConnectThunk } from '../../state/slices/cashconnectSlice';
import getElectrumAdapter from '../../services/ElectrumAdapter';
import { waitForWalletHistoryRefresh } from '../../services/RefreshCoordinator';
import { useTheme } from '../../app/theme/useTheme';
import PageHeader from '../../components/ui/PageHeader';
import SectionCard from '../../components/ui/SectionCard';
import SectionHeader from '../../components/ui/SectionHeader';
import SettingsRow from '../../components/ui/SettingsRow';
import Popup from '../../components/transaction/Popup';
import WalletScreen from '../../components/ui/WalletScreen';
import { AppDispatch, RootState } from '../../state/store';
import { getReturnPath } from '../../utils/navigation';
import {
  SETTINGS_GROUPS,
  getSettingsGroupRows,
  getParentSettingsGroup,
  getVisibleWalletRows,
  type SettingsRowConfig,
} from './settingsConfig';
import { isDesktopPlatform } from '../../utils/platform';
import { hasCapability } from '../../platform/capabilities';
import { useI18n } from '../../i18n/useI18n';
import { LanguageSettings } from './LanguageSettings';
import type { TranslationKey } from '../../i18n/resources';

const Settings: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { mode, toggleMode } = useTheme();
  const dispatch = useDispatch<AppDispatch>();
  const currentWalletId = useSelector(
    (state: RootState) => state.wallet_id.currentWalletId
  );
  const currentNetwork = useSelector((state: RootState) =>
    selectCurrentNetwork(state)
  );
  const desktop = isDesktopPlatform();
  const cashFusionEnabled = hasCapability('cashFusion');
  const { t } = useI18n();

  const [selectedOption, setSelectedOption] = useState(() => {
    const panel = searchParams.get('panel') ?? '';
    return (!desktop && panel === 'app-lock') ||
      (!cashFusionEnabled && panel === 'cashfusion')
      ? ''
      : panel;
  });
  const [isLogoutPopupOpen, setIsLogoutPopupOpen] = useState(false);
  const logoutNodeRef = useRef<HTMLDivElement | null>(null);
  const returnTarget = getReturnPath(location, '');
  const visibleWalletRows = getVisibleWalletRows(desktop, currentNetwork);
  const selectedGroup = selectedOption.startsWith('group:')
    ? selectedOption.slice('group:'.length)
    : null;
  const groupConfig = SETTINGS_GROUPS.find(
    (group) => group.key === selectedGroup
  );

  const getGroupTitle = (key: (typeof SETTINGS_GROUPS)[number]['key']) => {
    switch (key) {
      case 'wallet':
        return t('settings.walletSecurity');
      case 'features':
        return t('settings.connectionsFeatures');
      case 'about':
        return t('settings.aboutSupport');
    }
  };

  const getGroupDescription = (
    key: (typeof SETTINGS_GROUPS)[number]['key']
  ) => {
    switch (key) {
      case 'wallet':
        return t('settings.walletSecurityDescription');
      case 'features':
        return t('settings.connectionsFeaturesDescription');
      case 'about':
        return t('settings.aboutSupportDescription');
    }
  };

  const getRowTitle = (row: SettingsRowConfig) => {
    const keys: Record<string, TranslationKey> = {
      language: 'settingsRows.language',
      network: 'settingsRows.network',
      faucet: 'settingsRows.faucet',
      'wallet-info': 'settingsRows.walletInfo',
      derivation: 'settingsRows.derivation',
      recovery: 'settingsRows.recovery',
      'pending-outbox': 'settingsRows.pendingOutbox',
      'app-lock': 'settingsRows.appLock',
      'export-archive': 'settingsRows.exportArchive',
      'rebuild-wallet': 'settingsRows.rebuildWallet',
      nostr: 'settingsRows.nostr',
      server: 'settingsRows.server',
      console: 'settingsRows.console',
      experimental: 'settingsRows.experimental',
      addons: 'settingsRows.addons',
      'contract-info': 'settingsRows.contractInfo',
      walletconnect: 'settingsRows.walletConnect',
      wizardconnect: 'settingsRows.wizardConnect',
      about: 'settingsRows.about',
      terms: 'settingsRows.terms',
      contact: 'settingsRows.contact',
    };
    return keys[row.key] ? t(keys[row.key]) : row.title;
  };

  const getRowDescription = (row: SettingsRowConfig) => {
    const keys: Record<string, TranslationKey> = {
      language: 'settingsRows.languageDescription',
      network: 'settingsRows.networkDescription',
      faucet: 'settingsRows.faucetDescription',
      'wallet-info': 'settingsRows.walletInfoDescription',
      derivation: 'settingsRows.derivationDescription',
      recovery: 'settingsRows.recoveryDescription',
      'pending-outbox': 'settingsRows.pendingOutboxDescription',
      'app-lock': 'settingsRows.appLockDescription',
      'export-archive': 'settingsRows.exportArchiveDescription',
      'rebuild-wallet': 'settingsRows.rebuildWalletDescription',
      nostr: 'settingsRows.nostrDescription',
      server: 'settingsRows.serverDescription',
      console: 'settingsRows.consoleDescription',
      experimental: 'settingsRows.experimentalDescription',
      addons: 'settingsRows.addonsDescription',
      'contract-info': 'settingsRows.contractInfoDescription',
      walletconnect: 'settingsRows.walletConnectDescription',
      wizardconnect: 'settingsRows.wizardConnectDescription',
      cashconnect: 'settingsRows.cashConnectDescription',
      about: 'settingsRows.aboutDescription',
      terms: 'settingsRows.termsDescription',
      contact: 'settingsRows.contactDescription',
    };
    return keys[row.key] ? t(keys[row.key]) : row.description;
  };

  useEffect(() => {
    const panel = searchParams.get('panel') ?? '';
    setSelectedOption(
      (!desktop && panel === 'app-lock') ||
        (!cashFusionEnabled && panel === 'cashfusion')
        ? ''
        : panel
    );
  }, [cashFusionEnabled, desktop, searchParams]);

  const handleLogout = async () => {
    await waitForWalletHistoryRefresh(currentWalletId, {
      resetCooldown: true,
    });
    // On desktop this is a LOCK, not a wipe: clear the in-RAM key and return to
    // the wallet picker, leaving EVERY saved wallet intact. The mobile flow
    // below (deleteWallet + clearAllData) drops the whole wallet database, which
    // on desktop's multi-wallet picker wiped all saved wallets on logout.
    if (desktop) {
      try {
        const { lock } = await import('../../platform/desktop/OptnKeyManager');
        lock();
      } catch {
        /* ignore */
      }
      dispatch(setWalletId(0));
      dispatch(resetUTXOs());
      dispatch(resetTransactions());
      dispatch(resetWallet());
      dispatch(resetContract());
      dispatch(clearTransaction());
      await dispatch(disconnectAllWizardConnections());
      await dispatch(stopCashConnectThunk());
      try {
        await getElectrumAdapter().disconnect();
      } catch (e) {
        console.warn('[Settings] Electrum disconnect (on lock) warning:', e);
      }
      navigate('/');
      return;
    }

    const walletManager = WalletManager();
    await walletManager.deleteWallet(currentWalletId);
    await walletManager.clearAllData();
    dispatch(setWalletId(0));
    dispatch(resetUTXOs());
    dispatch(resetTransactions());
    dispatch(resetWallet());
    dispatch(resetContract());
    dispatch(resetNetwork());
    dispatch(clearTransaction());
    await dispatch(disconnectAllWizardConnections());
    await dispatch(stopCashConnectThunk());
    try {
      const electrum = getElectrumAdapter();
      await electrum.disconnect();
    } catch (e) {
      console.warn('[Settings] Electrum disconnect (on logout) warning:', e);
    }
    navigate('/');
  };

  const renderContent = () => {
    switch (selectedOption) {
      case 'recovery':
        return <RecoveryPhrase />;
      case 'language':
        return <LanguageSettings />;
      case 'about':
        return <AboutView />;
      case 'terms':
        return <TermsOfUse />;
      case 'contact':
        return <ContactUs />;
      case 'contract':
        // Legacy deep link — content now lives under About.
        return <AboutView />;
      case 'walletconnect':
        return <WalletConnectPanel />;
      case 'wizardconnect':
        return <WizardConnectPanel />;
      case 'cashconnect':
        return <CashConnectPanel />;
      case 'app-lock':
        return <AppLockSettings />;
      case 'export-archive':
        return desktop ? <ExportColdArchiveSettings /> : null;
      case 'rebuild-wallet':
        return desktop ? <RebuildWalletSettings /> : null;
      case 'network':
        return <NetworkSettings />;
      case 'faucet':
        return currentNetwork === Network.CHIPNET ? <FaucetView /> : null;
      case 'wallet-info':
        return <WalletInfoSettings />;
      case 'derivation':
        return <DerivationPathSettings />;
      case 'server':
        return <ServerSettings />;
      case 'console':
        return <ConsolePanel />;
      case 'experimental':
        return <ExperimentalSettings />;
      case 'cashfusion':
        return cashFusionEnabled ? <CashFusionSettings /> : null;
      case 'nostr':
        return <NostrSettings />;
      case 'addons':
        return <AddonsSettings />;
      default:
        return null;
    }
  };

  const renderTitle = () => {
    switch (selectedOption) {
      case 'recovery':
        return t('settings.recovery');
      case 'about':
        return t('settings.about');
      case 'language':
        return t('settings.language');
      case 'terms':
        return t('settings.terms');
      case 'contact':
        return t('settings.contact');
      case 'contract':
        return t('settingsPanels.contract');
      case 'app-lock':
        return t('settingsPanels.appLock');
      case 'export-archive':
        return t('settingsPanels.exportArchive');
      case 'rebuild-wallet':
        return t('settingsPanels.rebuildWallet');
      case 'server':
        return t('settingsPanels.server');
      case 'wallet-info':
        return t('settingsPanels.walletInfo');
      case 'derivation':
        return t('settingsPanels.derivation');
      case 'console':
        return t('settingsPanels.console');
      case 'experimental':
        return t('settingsPanels.experimental');
      case 'cashfusion':
        return t('settingsPanels.cashfusion');
      case 'nostr':
        return t('settingsPanels.nostr');
      case 'addons':
        return t('settingsPanels.addons');
      case 'walletconnect':
        return t('settingsPanels.walletConnect');
      case 'wizardconnect':
        return t('settingsPanels.wizardConnect');
      case 'cashconnect':
        return 'CashConnect';
      case 'network':
        return t('settings.network');
      case 'faucet':
        return t('settingsPanels.faucet');
      default:
        return '';
    }
  };

  const handleBack = () => {
    if (groupConfig) {
      setSelectedOption('');
      return;
    }
    if (selectedOption) {
      const parent = getParentSettingsGroup(
        selectedOption,
        desktop,
        currentNetwork
      );
      setSelectedOption(parent ? `group:${parent}` : '');
      return;
    }
    if (returnTarget) {
      navigate(returnTarget);
    }
  };
  const handleRowClick = (row: SettingsRowConfig) => {
    if (row.action === 'panel' && row.target) {
      setSelectedOption(row.target);
      return;
    }

    if (row.action === 'navigate' && row.target) {
      navigate(row.target);
    }
  };

  const renderRows = (rows: SettingsRowConfig[]) => (
    <div className="space-y-3">
      {rows.map((row) => (
        <SettingsRow
          key={row.key}
          title={getRowTitle(row)}
          description={getRowDescription(row)}
          compact
          right={
            row.key === 'network' ? (
              <span className="text-xs font-semibold capitalize text-[var(--wallet-accent)]">
                {currentNetwork}
              </span>
            ) : row.right ? (
              <span className="wallet-muted">{row.right}</span>
            ) : undefined
          }
          disabled={row.action === 'noop'}
          onClick={
            row.action === 'noop' ? undefined : () => handleRowClick(row)
          }
        />
      ))}
    </div>
  );

  return (
    <WalletScreen maxWidthClassName="max-w-md" scrollable={false}>
      <div className="flex h-full min-h-0 flex-col gap-4">
        <PageHeader title={t('app.settings')} compact />
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 -mt-8">
          <div aria-hidden="true" />
          <h1 className="justify-self-center text-[1.6rem] font-bold tracking-[-0.04em] wallet-text-strong">
            {t('app.settings')}
          </h1>
          <button
            onClick={toggleMode}
            className="justify-self-end flex items-center gap-2 rounded-full wallet-surface-strong border border-[var(--wallet-border)] px-2 py-1.5 text-sm font-semibold wallet-text-strong whitespace-nowrap"
            aria-label={t('app.toggleTheme')}
          >
            <MdSunny className="text-[12px] wallet-muted" />
            <span
              className={`relative inline-flex h-5 w-10 items-center rounded-full border transition-colors ${
                mode === 'dark'
                  ? 'bg-[var(--wallet-accent)] border-[var(--wallet-accent)]'
                  : 'wallet-surface border-[var(--wallet-border)]'
              }`}
            >
              <span
                className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${
                  mode === 'dark' ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </span>
            <MdModeNight className="text-[12px] wallet-muted" />
          </button>
        </div>

        <div className="flex flex-1 min-h-0 flex-col gap-4 overflow-hidden">
          {!selectedOption ? (
            <SectionCard className="min-h-0 overflow-hidden p-3">
              <div className="flex h-full min-h-0 flex-col gap-4">
                <div className="grid min-h-0 flex-1 grid-cols-1 gap-2.5 overflow-y-auto overscroll-contain pr-1">
                  <SectionCard className="p-0">
                    <SectionHeader title={t('app.quickAccess')} compact />
                    {renderRows(visibleWalletRows)}
                  </SectionCard>

                  {SETTINGS_GROUPS.map((group) => (
                    <SettingsRow
                      key={group.key}
                      title={getGroupTitle(group.key)}
                      description={getGroupDescription(group.key)}
                      compact
                      onClick={() => setSelectedOption(`group:${group.key}`)}
                    />
                  ))}
                </div>

                <button
                  onClick={() => setIsLogoutPopupOpen(true)}
                  className="wallet-btn-danger w-full py-3 text-base"
                >
                  {t('app.logOut')}
                </button>
              </div>
            </SectionCard>
          ) : (
            <>
              <SectionCard className="min-h-0 overflow-hidden">
                <div className="flex h-full min-h-0 flex-col">
                  <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1">
                    <div className="mb-4 flex items-center justify-between">
                      <h2 className="text-xl font-bold wallet-text-strong">
                        {groupConfig
                          ? getGroupTitle(groupConfig.key)
                          : renderTitle()}
                      </h2>
                    </div>
                    {groupConfig
                      ? renderRows(
                          getSettingsGroupRows(
                            groupConfig.key,
                            desktop,
                            currentNetwork
                          )
                        )
                      : renderContent()}
                  </div>
                </div>
              </SectionCard>
              <div className="mt-auto pb-2 pt-3">
                <button
                  className="wallet-btn-danger w-full py-3 text-base font-semibold"
                  onClick={handleBack}
                >
                  {t('app.back')}
                </button>
              </div>
            </>
          )}
        </div>

        {isLogoutPopupOpen && (
          <Popup closePopups={() => setIsLogoutPopupOpen(false)}>
            <div
              ref={logoutNodeRef}
              className="wallet-card mx-auto w-full max-w-md p-4"
            >
              <div className="mb-3 text-center text-sm wallet-muted">
                {t('app.confirmLogoutDescription')}
              </div>
              <button
                className="wallet-btn-danger mt-2 w-full"
                onClick={handleLogout}
              >
                {t('app.confirmLogout')}
              </button>
            </div>
          </Popup>
        )}
      </div>
    </WalletScreen>
  );
};

export default Settings;
