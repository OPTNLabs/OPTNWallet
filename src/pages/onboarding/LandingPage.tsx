import { Link } from 'react-router-dom';
import { useTheme } from '../../context/useTheme';
import { ONBOARDING_WELCOME_IMAGE } from './constants';

const ThemeModeSwitch = () => {
  const { mode, setMode } = useTheme();

  return (
    <div className="wallet-surface-strong border border-[var(--wallet-border)] rounded-full p-1 inline-flex items-center gap-1 shadow-sm">
      <button
        type="button"
        onClick={() => setMode('light')}
        className={`px-4 py-1.5 rounded-full text-sm font-semibold transition ${
          mode === 'light' ? 'wallet-card wallet-text-strong' : 'wallet-muted hover:opacity-100'
        }`}
        aria-pressed={mode === 'light'}
      >
        Light
      </button>
      <button
        type="button"
        onClick={() => setMode('dark')}
        className={`px-4 py-1.5 rounded-full text-sm font-semibold transition ${
          mode === 'dark' ? 'wallet-card wallet-text-strong' : 'wallet-muted hover:opacity-100'
        }`}
        aria-pressed={mode === 'dark'}
      >
        Dark
      </button>
    </div>
  );
};

const LandingPage = () => {
  return (
    <section className="min-h-[100dvh] wallet-surface flex flex-col justify-center items-center px-4 relative">
      <div className="safe-area-top" />

      <div className="absolute top-0 left-0 right-0 flex justify-center px-4 pt-[calc(var(--safe-top)+0.75rem)] z-10">
        <ThemeModeSwitch />
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
          <h1 className="text-lg font-bold lg:text-xl wallet-text-strong mx-6 max-w-md">
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

      <div className="safe-area-bottom" />
    </section>
  );
};

export default LandingPage;
