/** @vitest-environment jsdom */

import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  navigate: vi.fn(),
  getAllWallets: vi.fn(),
  openWalletWithPassword: vi.fn(),
}));

vi.mock('react-redux', () => ({
  useDispatch: () => mocks.dispatch,
  useSelector: (selector: (state: unknown) => unknown) =>
    selector({
      wallet_id: { currentWalletId: 0, networkType: 'mainnet' },
      network: { currentNetwork: 'mainnet' },
      hardwareWallet: {
        type: 'none',
        connected: false,
        xpub: null,
        deviceLabel: null,
        derivationPath: "m/44'/145'/0'",
        ledgerTransport: 'usb',
      },
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
  useLocation: () => ({ state: null, key: 'initial' }),
  useNavigate: () => mocks.navigate,
}));

vi.mock('../../../../i18n/useI18n', () => ({
  useI18n: () => ({
    t: (key: string, values?: { name?: string }) => {
      const translations: Record<string, string> = {
        'desktopWallet.yourWallets': 'Your wallets',
        'desktopWallet.openButton': 'Open',
        'desktopWallet.password': 'Password',
        'desktopWallet.unlock': 'Unlock',
        'desktopWallet.incorrectFilePassword': 'Incorrect password.',
        'desktopWallet.addAnother': 'Add another wallet',
        'onboarding.createNewWallet': 'Create New Wallet',
        'onboarding.importWallet': 'Import Wallet',
        'onboarding.connectHardware': 'Connect Hardware Wallet',
        'onboarding.createWatchOnly': 'Create Watch-Only Wallet',
        'onboarding.helpTitle': 'Help',
        'settingsNetwork.mainnet': 'Mainnet',
      };
      if (key === 'desktopWallet.deleteLabel') {
        return `Delete ${values?.name ?? 'wallet'}`;
      }
      return translations[key] ?? key;
    },
  }),
}));

vi.mock('../../../../apis/WalletManager/WalletManager', () => ({
  default: () => ({ getAllWallets: mocks.getAllWallets }),
}));

vi.mock('../../../../apis/DatabaseManager/DatabaseService', () => ({
  default: () => ({ deleteWalletFromFile: vi.fn() }),
}));

vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getAllWebviewWindows: vi.fn().mockResolvedValue([]),
  getCurrentWebviewWindow: vi.fn(() => ({ label: 'main' })),
}));

vi.mock('../../../../platform/desktop/DesktopWalletManager', () => ({
  openWalletWithPassword: mocks.openWalletWithPassword,
  importWalletFile: vi.fn(),
  isBiometricAvailable: vi.fn().mockResolvedValue(false),
  hasWalletBiometric: vi.fn().mockResolvedValue(false),
  unlockWalletWithBiometric: vi.fn(),
  getBiometricLabel: vi.fn(() => 'biometric'),
}));

vi.mock('../../../../platform/desktop/walletOpenRegistry', () => ({
  runExclusiveWalletOpen: vi.fn(async (_id, _label, open) => {
    const value = await open();
    return value === null
      ? { status: 'rejected' }
      : { status: 'opened', value };
  }),
}));

vi.mock('../../../../platform/desktop/walletFusionPolicy', () => ({
  clearWalletFusionPolicy: vi.fn(),
}));

vi.mock('../../../../features/settings/HardwareWalletSettings', () => ({
  HardwareWalletSettings: () => null,
}));

vi.mock('../../onboarding/WatchOnlyWalletPreview', () => ({
  WatchOnlyWalletPreview: ({ onBack }: { onBack: () => void }) =>
    React.createElement(
      'button',
      { type: 'button', onClick: onBack },
      'Watch-only preview'
    ),
}));

vi.mock('../../../../components/LanguagePicker', () => ({
  default: () => null,
}));

import DesktopLandingPage from '../../onboarding/DesktopLandingPage';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('DesktopLandingPage UI', () => {
  beforeEach(() => {
    mocks.getAllWallets.mockResolvedValue([
      {
        id: 7,
        wallet_name: 'Demo Wallet',
        networkType: 'mainnet',
        walletType: 'standard',
      },
    ]);
    mocks.openWalletWithPassword.mockReset();
  });

  it('keeps a wallet locked after a wrong password and opens it after retry', async () => {
    const user = userEvent.setup();
    mocks.openWalletWithPassword
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ network: 'mainnet', walletType: 'standard' });

    render(<DesktopLandingPage />);

    expect(await screen.findByText('Demo Wallet')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open' }));

    const password = screen.getByPlaceholderText('Password');
    await user.type(password, 'wrong-password');
    await user.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(await screen.findByText('Incorrect password.')).toBeInTheDocument();
    expect(mocks.navigate).not.toHaveBeenCalled();

    await user.clear(password);
    await user.type(password, 'correct-password');
    await user.click(screen.getByRole('button', { name: 'Unlock' }));

    await waitFor(() => {
      expect(mocks.openWalletWithPassword).toHaveBeenCalledTimes(2);
      expect(mocks.navigate).toHaveBeenCalledWith('/home/7');
    });
  });

  it('exposes the watch-only route from the wallet picker', async () => {
    const user = userEvent.setup();
    render(<DesktopLandingPage />);

    await screen.findByText('Demo Wallet');
    await user.click(
      screen.getByRole('button', { name: 'Create Watch-Only Wallet' })
    );

    expect(
      screen.getByRole('button', { name: 'Watch-only preview' })
    ).toBeInTheDocument();
  });

  it('does not expose the internal mobile multisig wallet in the desktop picker', async () => {
    mocks.getAllWallets.mockResolvedValue([
      {
        id: 7,
        wallet_name: 'Demo Wallet',
        networkType: 'mainnet',
        walletType: 'standard',
      },
      {
        id: 8,
        wallet_name: 'Mobile Internal Policy',
        networkType: 'mainnet',
        walletType: 'multisig',
      },
    ]);

    render(<DesktopLandingPage />);

    expect(await screen.findByText('Demo Wallet')).toBeInTheDocument();
    expect(
      screen.queryByText('Mobile Internal Policy')
    ).not.toBeInTheDocument();
  });
});
