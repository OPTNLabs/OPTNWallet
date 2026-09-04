/** @vitest-environment jsdom */

import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock('../../../app/theme/useTheme', () => ({
  useTheme: () => ({
    mode: 'dark',
    setMode: vi.fn(),
    toggleMode: vi.fn(),
  }),
}));

vi.mock('react-redux', () => ({
  useDispatch: () => mocks.dispatch,
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
  useNavigate: () => mocks.navigate,
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

vi.mock('../../../platform/desktop/onboarding/WatchOnlyWalletPreview', () => ({
  WatchOnlyWalletPreview: ({ onBack }: { onBack: () => void }) =>
    React.createElement(
      'button',
      { type: 'button', onClick: onBack },
      'Watch-only preview'
    ),
}));

vi.mock('../../../platform/desktop/DesktopWalletManager', () => ({
  openWatchOnlyWallet: vi.fn(),
}));

import LandingPage from '../LandingPage';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('mobile landing watch-only', () => {
  it('opens the watch-only create form from the landing page', async () => {
    const user = userEvent.setup();
    render(<LandingPage />);

    expect(
      screen.getByRole('button', { name: 'Create Watch-Only Wallet' })
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create Wallet' })).toHaveAttribute(
      'href',
      '/createwallet'
    );

    await user.click(
      screen.getByRole('button', { name: 'Create Watch-Only Wallet' })
    );
    expect(
      screen.getByRole('button', { name: 'Watch-only preview' })
    ).toBeInTheDocument();
  });
});
