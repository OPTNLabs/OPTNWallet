/** @vitest-environment jsdom */

import React from 'react';
import '@testing-library/jest-dom/vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  navigate: vi.fn(),
  getAllWallets: vi.fn(),
  openWalletWithPassword: vi.fn(),
  unlockWalletWithBiometric: vi.fn(),
  isBiometricAvailable: vi.fn(),
  hasWalletBiometric: vi.fn(),
  importWalletFile: vi.fn(),
  importColdData: vi.fn(),
  engine: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('react-redux', () => ({
  useDispatch: () => mocks.dispatch,
  useSelector: (selector: (state: unknown) => unknown) =>
    selector({
      wallet_id: { currentWalletId: 0, networkType: 'mainnet' },
      network: { currentNetwork: 'mainnet' },
      appLock: { autoLockMinutes: 30 },
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
  importWalletFile: mocks.importWalletFile,
  isBiometricAvailable: mocks.isBiometricAvailable,
  hasWalletBiometric: mocks.hasWalletBiometric,
  unlockWalletWithBiometric: mocks.unlockWalletWithBiometric,
  getBiometricLabel: vi.fn(() => 'biometric'),
}));

vi.mock('../../engineWalletBridge', () => ({
  openWalletInEngine: mocks.engine,
}));
vi.mock('../../toast', () => ({ Toast: { show: mocks.toast } }));
vi.mock('../../WalletPackService', () => ({
  importColdDataIntoOpenWallet: mocks.importColdData,
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

vi.mock('../../../../utils/platform', () => ({
  isDesktopPlatform: () => true,
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
    mocks.isBiometricAvailable.mockResolvedValue(false);
    mocks.hasWalletBiometric.mockResolvedValue(false);
    mocks.engine.mockReset().mockResolvedValue({ opened: true });
    mocks.toast.mockReset().mockResolvedValue(undefined);
    mocks.importColdData.mockReset().mockResolvedValue({ labels: 0 });
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

  it('shows the hardware-wallet action on desktop', async () => {
    render(<DesktopLandingPage />);
    expect(
      await screen.findByRole('button', { name: 'Connect Hardware Wallet' })
    ).toBeInTheDocument();
  });

  it.each([false, true])(
    'keeps biometric unlock successful when engine warns (toast failure: %s)',
    async (toastFails) => {
      mocks.isBiometricAvailable.mockResolvedValue(true);
      mocks.hasWalletBiometric.mockResolvedValue(true);
      mocks.unlockWalletWithBiometric.mockResolvedValue({
        networkType: 'mainnet',
        walletType: 'standard',
        engineWarning: 'HD inventory could not be imported.',
      });
      if (toastFails)
        mocks.toast.mockRejectedValueOnce(new Error('toast unavailable'));
      const user = userEvent.setup();
      render(<DesktopLandingPage />);
      await user.click(await screen.findByRole('button', { name: 'Open' }));
      await user.click(
        await screen.findByRole('button', {
          name: 'desktopWallet.useBiometric',
        })
      );
      await waitFor(() =>
        expect(mocks.navigate).toHaveBeenCalledWith('/home/7')
      );
      expect(mocks.unlockWalletWithBiometric).toHaveBeenCalledExactlyOnceWith(
        7,
        30
      );
      expect(mocks.toast).toHaveBeenCalledWith({
        text: 'HD inventory could not be imported.',
        duration: 'long',
      });
      expect(mocks.engine).not.toHaveBeenCalled();
    }
  );

  it.each([false, true])(
    'hands off a file import after cold data (reused wallet: %s)',
    async (reusedExisting) => {
      mocks.importWalletFile.mockResolvedValue({
        walletId: 11,
        network: 'chipnet',
        walletType: 'standard',
        reusedExisting,
      });
      mocks.engine.mockResolvedValue({
        opened: false,
        reason: 'Inventory import failed.',
      });
      const user = userEvent.setup();
      render(<DesktopLandingPage />);
      await screen.findByText('Demo Wallet');
      fireEvent(
        window,
        new CustomEvent('optn:import-wallet-file', {
          detail: {
            file: { name: 'Imported fixture', network: 'chipnet' },
            coldArchiveText: 'synthetic-cold-data',
          },
        })
      );
      await user.type(
        screen.getByPlaceholderText('Password'),
        'synthetic-password'
      );
      await user.click(
        screen.getByRole('button', { name: 'desktopWallet.open' })
      );
      await waitFor(() =>
        expect(mocks.navigate).toHaveBeenCalledWith('/home/11')
      );
      expect(mocks.engine).toHaveBeenCalledExactlyOnceWith(
        11,
        'synthetic-password',
        30
      );
      expect(mocks.importColdData.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.engine.mock.invocationCallOrder[0]
      );
      expect(mocks.engine.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.navigate.mock.invocationCallOrder[0]
      );
      expect(mocks.toast).toHaveBeenCalledWith({
        text: 'Inventory import failed.',
        duration: 'long',
      });
    }
  );

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
