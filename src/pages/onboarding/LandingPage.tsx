import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTheme } from '../../context/useTheme';
import { ONBOARDING_WELCOME_IMAGE } from './constants';
import WalkthroughPanel from '../../components/ui/WalkthroughPanel';
import Popup from '../../components/transaction/Popup';
import { MdSunny, MdModeNight } from 'react-icons/md';

const ThemeModeSwitch = () => {
  const { mode, toggleMode } = useTheme();

  return (
    <button
      type="button"
      onClick={toggleMode}
      className="flex items-center gap-2 rounded-full wallet-surface-strong border border-[var(--wallet-border)] px-2 py-1.5 text-sm font-semibold wallet-text-strong whitespace-nowrap"
      aria-label="Toggle theme"
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

  return (
    <section className="min-h-[100dvh] wallet-surface flex flex-col justify-center items-center px-4 relative">
      <div className="safe-area-top" />

      <div className="absolute top-0 left-0 right-0 z-10 px-4 pt-[calc(var(--safe-top)+1.15rem)]">
        <div className="mx-auto grid w-full max-w-6xl grid-cols-[1fr_auto_1fr] items-center">
          <div />
          <ThemeModeSwitch />
          <div className="justify-self-end">
            <button
              type="button"
              onClick={() => setShowHelp(true)}
              className="wallet-chip shrink-0"
            >
              Help
            </button>
          </div>
        </div>
      </div>

      <main className="flex flex-col lg:flex-row items-center max-w-6xl mx-auto gap-8 lg:gap-12 pt-20 sm:pt-16">
        <div className="flex justify-center w-full lg:w-1/2">
          <img
            src={ONBOARDING_WELCOME_IMAGE}
            alt="Smart BCH Wallet"
            className="max-w-full h-auto w-3/4 lg:w-full object-contain transition-transform duration-300 hover:scale-105"
          />
        </div>

        <div className="wallet-card p-6 sm:p-8 flex flex-col w-full lg:w-1/2 items-center lg:items-start text-center lg:text-left">
          <h1 className="text-lg font-bold lg:text-xl wallet-text-strong mx-auto max-w-md text-center">
            Powered with Bitcoin Covenants for Bitcoin Cash
          </h1>

          <div className="flex flex-col sm:flex-row gap-4 mt-20">
            <Link
              to="/createwallet"
              className="wallet-btn-primary py-3 px-10 rounded-lg mx-2 my-2 shadow-md"
            >
              Create Wallet
            </Link>
            <Link
              to="/importwallet"
              className="wallet-btn-secondary py-3 px-10 rounded-lg mx-2 my-2 shadow-md"
            >
              Import Wallet
            </Link>
          </div>
        </div>
      </main>

      {showHelp && (
        <Popup closePopups={() => setShowHelp(false)} closeButtonText="Close help">
          <WalkthroughPanel
            title="Getting started"
            description="Use this screen to create a wallet for the first time or restore one you already have. Pick the network first, then continue into the wallet."
            steps={[
              {
                title: 'Create Wallet',
                description:
                  'Use this if you want a new wallet with a fresh seed phrase on this device.',
              },
              {
                title: 'Import Wallet',
                description:
                  'Use this if you already have a 12-word recovery phrase and want access to an existing wallet.',
              },
              {
                title: 'Choose a network',
                description:
                  'Select Mainnet for real funds or CHIPNET for test funds before you proceed.',
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
