/** @vitest-environment jsdom */

import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const capability = vi.hoisted(() => ({
  hardwareWallet: true,
  watchOnlyWallet: true,
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

vi.mock('../../../../i18n/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        'onboarding.createWallet': 'Create Wallet',
        'onboarding.createNewWallet': 'Create New Wallet',
        'onboarding.importWallet': 'Import Wallet',
        'onboarding.connectHardware': 'Connect Hardware Wallet',
        'onboarding.createWatchOnly': 'Create Watch-Only Wallet',
        'desktopWallet.addAnother': 'Add another wallet',
      };
      return translations[key] ?? key;
    },
  }),
}));

vi.mock('../../../capabilities', () => ({
  hasCapability: (name: string) => {
    if (name === 'hardwareWallet') return capability.hardwareWallet;
    if (name === 'watchOnlyWallet') return capability.watchOnlyWallet;
    return false;
  },
}));

import { DesktopWalletPickerActions } from '../DesktopWalletPickerActions';

afterEach(() => {
  cleanup();
});

describe('DesktopWalletPickerActions hardware toggle', () => {
  it('shows Connect Hardware Wallet when the capability is on', () => {
    capability.hardwareWallet = true;
    render(
      <DesktopWalletPickerActions
        hasWallets={false}
        onHardware={() => undefined}
        onWatchOnly={() => undefined}
      />
    );
    expect(
      screen.getByRole('button', { name: 'Connect Hardware Wallet' })
    ).toBeInTheDocument();
  });

  it('hides Connect Hardware Wallet when the capability is off', () => {
    capability.hardwareWallet = false;
    render(
      <DesktopWalletPickerActions
        hasWallets={false}
        onHardware={() => undefined}
        onWatchOnly={() => undefined}
      />
    );
    expect(
      screen.queryByRole('button', { name: 'Connect Hardware Wallet' })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Create Watch-Only Wallet' })
    ).toBeInTheDocument();
  });

  it('hides Create Watch-Only Wallet when the capability is off', () => {
    capability.hardwareWallet = false;
    capability.watchOnlyWallet = false;
    render(
      <DesktopWalletPickerActions
        hasWallets={false}
        onHardware={() => undefined}
        onWatchOnly={() => undefined}
      />
    );
    expect(
      screen.queryByRole('button', { name: 'Create Watch-Only Wallet' })
    ).not.toBeInTheDocument();
  });
});
