/** @vitest-environment jsdom */

import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('../../../app/theme/useTheme', () => ({
  useTheme: () => ({ mode: 'dark', toggleMode: vi.fn() }),
}));

vi.mock('../../../i18n/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => {
      const messages: Record<string, string> = {
        'app.help': 'Help',
        'onboarding.toggleTheme': 'Toggle theme',
        'onboarding.welcomeAlt': 'OPTN Wallet',
        'onboarding.poweredBy':
          'Powered with Bitcoin Covenants for Bitcoin Cash',
        'onboarding.createWallet': 'Create Wallet',
        'onboarding.importWallet': 'Import Wallet',
        'onboarding.createWatchOnly': 'Create Watch-Only Wallet',
      };
      return messages[key] ?? key;
    },
  }),
}));

vi.mock('../../../components/LanguagePicker', () => ({
  default: () => React.createElement('div', null, 'English'),
}));

vi.mock('../../../components/ui/WalkthroughPanel', () => ({
  default: () => null,
}));

vi.mock('../../../components/transaction/Popup', () => ({
  default: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
}));

import LandingPage from '../LandingPage';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('onboarding watch-only capability', () => {
  it.each(['android', 'ios'] as const)(
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

  it.each(['web', 'extension'] as const)(
    'keeps watch-only out of the %s surface',
    (surface) => {
      render(<LandingPage surface={surface} />);
      expect(
        screen.queryByRole('link', { name: 'Create Watch-Only Wallet' })
      ).not.toBeInTheDocument();
    }
  );
});
