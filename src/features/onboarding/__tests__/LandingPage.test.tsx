/** @vitest-environment jsdom */

// The landing page's watch-only door.
//
// Two things are checked here and they are gated on different facts. Watch
// Only is offered on every surface, because it needs no transport at all — an
// account xPub can be pasted, so a popup with no camera and no USB can still
// watch a cold wallet. Hardware is off where the vendor integration does not
// exist yet, which is work rather than a limit of the platform.

import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../app/theme/useTheme', () => ({
  useTheme: () => ({
    mode: 'dark',
    setMode: vi.fn(),
    toggleMode: vi.fn(),
  }),
}));

vi.mock('react-router-dom', () => ({
  Link: ({
    to,
    children,
    ...props
  }: {
    to: string;
    children: React.ReactNode;
  }) => React.createElement('a', { ...props, href: to }, children),
}));

vi.mock('../../../i18n/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        'onboarding.toggleTheme': 'Toggle theme',
        'app.help': 'Help',
        'onboarding.welcomeAlt': 'Welcome',
        'onboarding.poweredBy': 'OPTN Wallet',
        'onboarding.createWallet': 'Create Wallet',
        'onboarding.importWallet': 'Import Wallet',
        'onboarding.createWatchOnly': 'Create Watch-Only Wallet',
        'onboarding.closeHelp': 'Close',
        'onboarding.helpTitle': 'Help',
        'onboarding.helpDescription': 'Help body',
        'onboarding.helpCreateTitle': 'Create',
        'onboarding.helpCreateDescription': 'Create a wallet',
        'onboarding.helpImportTitle': 'Import',
        'onboarding.helpImportDescription': 'Import a wallet',
        'onboarding.helpNetworkTitle': 'Network',
        'onboarding.helpNetworkDescription': 'Choose a network',
        'watchOnly.description':
          'Inspect public BCH addresses without importing any private keys.',
      };
      return translations[key] ?? key;
    },
  }),
}));

vi.mock('../../../components/LanguagePicker', () => ({
  default: () => React.createElement('div', null, 'Language'),
}));

import LandingPage from '../LandingPage';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe('onboarding watch-only capability', () => {
  it('shows watch-only from the android build stamp without an explicit surface prop', () => {
    vi.stubEnv('VITE_APP_SURFACE', 'android');
    render(<LandingPage />);

    expect(
      screen.getByRole('link', { name: 'Create Wallet' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Import Wallet' })
    ).toBeInTheDocument();
    expect(screen.getByTestId('watch-only-landing-action')).toHaveAttribute(
      'href',
      '/watch-only'
    );
  });

  it.each(['desktop', 'android', 'ios', 'web', 'extension'] as const)(
    'shows watch-only alongside create and import on %s',
    (surface) => {
      render(<LandingPage surface={surface} />);

      expect(
        screen.getByRole('link', { name: 'Create Wallet' })
      ).toHaveAttribute('href', '/createwallet');
      expect(
        screen.getByRole('link', { name: 'Import Wallet' })
      ).toHaveAttribute('href', '/importwallet');
      expect(
        screen.getByRole('link', { name: 'Create Watch-Only Wallet' })
      ).toHaveAttribute('href', '/watch-only');
    }
  );

  it.each(['android', 'ios', 'web', 'extension'] as const)(
    'keeps hardware off %s, where the vendor integration does not exist yet',
    (surface) => {
      render(<LandingPage surface={surface} />);

      // Watch-only is still here. The two are separate doors: one needs a
      // vendor integration, the other needs somewhere to paste an xPub.
      expect(
        screen.getByRole('link', { name: 'Create Watch-Only Wallet' })
      ).toBeInTheDocument();
      expect(
        screen.queryByRole('link', { name: /hardware/i })
      ).not.toBeInTheDocument();
    }
  );

  it('offers exactly one watch-only control, not two doing different things', () => {
    // The merge briefly produced both: a Link to /watch-only and a button
    // opening a desktop-only inline preview of the same flow, sharing a
    // label. WatchOnlyWalletPage now serves every surface, so the route is
    // the single door and this is what stops the duplicate returning.
    render(<LandingPage surface="desktop" />);

    expect(
      screen.getAllByRole('link', { name: 'Create Watch-Only Wallet' })
    ).toHaveLength(1);
    expect(
      screen.queryByRole('button', { name: 'Create Watch-Only Wallet' })
    ).not.toBeInTheDocument();
  });
});
