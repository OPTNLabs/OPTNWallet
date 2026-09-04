import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useDispatch } from 'react-redux';
import { useTheme } from '../../app/theme/useTheme';
import { ONBOARDING_WELCOME_IMAGE } from './constants';
import WalkthroughPanel from '../../components/ui/WalkthroughPanel';
import Popup from '../../components/transaction/Popup';
import { MdSunny, MdModeNight } from 'react-icons/md';
import { useI18n } from '../../i18n/useI18n';
import LanguagePicker from '../../components/LanguagePicker';
import { WatchOnlyWalletPreview } from '../../platform/desktop/onboarding/WatchOnlyWalletPreview';
import { openWatchOnlyWallet } from '../../platform/desktop/DesktopWalletManager';
import {
  setWalletDerivationPath,
  setWalletId,
  setWalletNetwork,
  setWalletType,
} from '../../state/slices/walletSlice';
import { Network, setNetwork } from '../../state/slices/networkSlice';
import { homeRoute } from '../../navigation/routes';

const ThemeModeSwitch = () => {
  const { mode, toggleMode } = useTheme();
  const { t } = useI18n();

  return (
    <button
      type="button"
      onClick={toggleMode}
      className="flex items-center gap-2 rounded-full wallet-surface-strong border border-[var(--wallet-border)] px-2 py-1.5 text-sm font-semibold wallet-text-strong whitespace-nowrap"
      aria-label={t('onboarding.toggleTheme')}
    >
      <MdSunny className="text-[12px] wallet-muted" />
      <span
        className={`relative inline-flex h-5 w-10 items-center rounded-full border transition-colors ${
          mode === 'dark'
            ? 'bg-[var(--wallet-accent)] border-[var(--wallet-accent)]'
            : 'wallet-surface border-[var(--wallet-border)]'
        }`}
        aria-hidden="true"
      >
        <span
          className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${
            mode === 'dark' ? 'translate-x-5' : 'translate-x-0'
          }`}
        />
      </span>
      <MdModeNight className="text-[12px] wallet-muted" />
    </button>
  );
};

const LandingPage = () => {
  const [showHelp, setShowHelp] = useState(false);
  const [watchOnly, setWatchOnly] = useState(false);
  const [openError, setOpenError] = useState('');
  const { t } = useI18n();
  const dispatch = useDispatch();
  const navigate = useNavigate();

  const handleWatchOnlyCreated = async (walletId: number) => {
    setOpenError('');
    try {
      const info = await openWatchOnlyWallet(walletId);
      if (!info) {
        setOpenError('Wallet created, but could not open it.');
        setWatchOnly(false);
        return;
      }
      dispatch(setWalletId(walletId));
      dispatch(setWalletNetwork(info.networkType ?? Network.MAINNET));
      dispatch(setWalletType(info.walletType ?? 'watch-only'));
      if (info.derivation_path) {
        dispatch(
          setWalletDerivationPath({
            path: info.derivation_path,
            source:
              info.derivation_path_source === 'custom' ? 'custom' : 'default',
          })
        );
      }
      dispatch(setNetwork(info.networkType ?? Network.MAINNET));
      navigate(homeRoute(walletId));
    } catch (err) {
      setOpenError(
        err instanceof Error
          ? err.message
          : 'Wallet created, but could not open it.'
      );
      setWatchOnly(false);
    }
  };

  if (watchOnly) {
    return (
      <WatchOnlyWalletPreview
        onBack={() => {
          setOpenError('');
          setWatchOnly(false);
        }}
        onCreated={(walletId) => void handleWatchOnlyCreated(walletId)}
      />
    );
  }

  return (
    <section className="min-h-[100dvh] wallet-surface flex flex-col justify-center items-center px-4 relative">
      <div className="safe-area-top" />

      <div className="absolute top-0 left-0 right-0 z-10 px-4 pt-[calc(var(--safe-top)+1.15rem)]">
        <div className="mx-auto grid w-full max-w-6xl grid-cols-[1fr_auto_1fr] items-center">
          <LanguagePicker />
          <ThemeModeSwitch />
          <div className="justify-self-end">
            <button
              type="button"
              onClick={() => setShowHelp(true)}
              className="wallet-chip shrink-0"
            >
              {t('app.help')}
            </button>
          </div>
        </div>
      </div>

      <main className="flex flex-col lg:flex-row items-center max-w-6xl mx-auto gap-8 lg:gap-12 pt-20 sm:pt-16">
        <div className="flex justify-center w-full lg:w-1/2">
          <img
            src={ONBOARDING_WELCOME_IMAGE}
            alt={t('onboarding.welcomeAlt')}
            className="max-w-full h-auto w-3/4 lg:w-full object-contain transition-transform duration-300 hover:scale-105"
          />
        </div>

        <div className="wallet-card p-6 sm:p-8 flex flex-col w-full lg:w-1/2 items-center lg:items-start text-center lg:text-left">
          <h1 className="text-lg font-bold lg:text-xl wallet-text-strong mx-auto max-w-md text-center">
            {t('onboarding.poweredBy')}
          </h1>

          <div className="flex flex-col sm:flex-row gap-4 mt-20">
            <Link
              to="/createwallet"
              className="wallet-btn-primary py-3 px-10 rounded-lg mx-2 my-2 shadow-md"
            >
              {t('onboarding.createWallet')}
            </Link>
            <Link
              to="/importwallet"
              className="wallet-btn-secondary py-3 px-10 rounded-lg mx-2 my-2 shadow-md"
            >
              {t('onboarding.importWallet')}
            </Link>
          </div>
          <button
            type="button"
            onClick={() => {
              setOpenError('');
              setWatchOnly(true);
            }}
            className="wallet-btn-secondary py-3 px-10 rounded-lg mx-2 my-2 shadow-md"
          >
            {t('onboarding.createWatchOnly')}
          </button>
          {openError ? (
            <p role="alert" className="mt-2 text-xs text-red-400">
              {openError}
            </p>
          ) : null}
        </div>
      </main>

      {showHelp && (
        <Popup
          closePopups={() => setShowHelp(false)}
          closeButtonText={t('onboarding.closeHelp')}
        >
          <WalkthroughPanel
            title={t('onboarding.helpTitle')}
            description={t('onboarding.helpDescription')}
            steps={[
              {
                title: t('onboarding.helpCreateTitle'),
                description: t('onboarding.helpCreateDescription'),
              },
              {
                title: t('onboarding.helpImportTitle'),
                description: t('onboarding.helpImportDescription'),
              },
              {
                title: t('onboarding.helpNetworkTitle'),
                description: t('onboarding.helpNetworkDescription'),
              },
              {
                title: t('onboarding.createWatchOnly'),
                description: t('watchOnly.description'),
              },
            ]}
            numbered={false}
            className="max-w-none"
          />
        </Popup>
      )}

      <div className="safe-area-bottom" />
    </section>
  );
};

export default LandingPage;
