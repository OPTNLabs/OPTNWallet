import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTheme } from '../../app/theme/useTheme';
import { ONBOARDING_WELCOME_IMAGE } from './constants';
import WalkthroughPanel from '../../components/ui/WalkthroughPanel';
import Popup from '../../components/transaction/Popup';
import { MdSunny, MdModeNight } from 'react-icons/md';
import { useI18n } from '../../i18n/useI18n';
import LanguagePicker from '../../components/LanguagePicker';
import {
  currentSurface,
  hasCapability,
  type Surface,
} from '../../platform/capabilities';
import { ROUTE_PATHS } from '../../navigation/routes';

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

type LandingPageProps = {
  /** Explicit surface makes native capability rendering deterministic and testable. */
  surface?: Surface;
};

const LandingPage = ({ surface }: LandingPageProps) => {
  const [showHelp, setShowHelp] = useState(false);
  const resolvedSurface = surface ?? currentSurface();
  const { t } = useI18n();

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

          <div className="flex w-full flex-col sm:flex-row sm:flex-wrap gap-3 sm:gap-4 mt-10 sm:mt-12 lg:mt-20 justify-center">
            <Link
              to="/createwallet"
              className="wallet-btn-primary w-full sm:w-auto py-3 px-10 rounded-lg sm:mx-2 sm:my-2 shadow-md"
            >
              {t('onboarding.createWallet')}
            </Link>
            <Link
              to="/importwallet"
              className="wallet-btn-secondary w-full sm:w-auto py-3 px-10 rounded-lg sm:mx-2 sm:my-2 shadow-md"
            >
              {t('onboarding.importWallet')}
            </Link>
            {hasCapability('watchOnlyWallet', resolvedSurface) && (
              <Link
                to={ROUTE_PATHS.watchOnlyWallet}
                className="wallet-btn-secondary w-full sm:w-auto py-3 px-10 rounded-lg sm:mx-2 sm:my-2 shadow-md"
              >
                {t('onboarding.createWatchOnly')}
              </Link>
            )}
          </div>
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
