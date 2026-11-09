/** @vitest-environment jsdom */

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock('react-redux', () => ({
  useDispatch: () => mocks.dispatch,
  useSelector: (selector: (state: unknown) => unknown) =>
    selector({
      wallet_id: { currentWalletId: 0, networkType: 'mainnet' },
      network: { currentNetwork: 'mainnet' },
    }),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => mocks.navigate,
}));

vi.mock('../../../i18n/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) =>
      ({
        'onboarding.createWatchOnly': 'Create Watch-Only Wallet',
        'onboarding.welcomeAlt': 'OPTN Wallet',
        'onboarding.helpNetworkDescription':
          'Select Mainnet for real funds or CHIPNET for test funds before you proceed.',
        'onboarding.back': 'Back',
        'watchOnly.description':
          'Inspect public BCH addresses without importing any private keys.',
        'watchOnly.network': 'Network',
        'watchOnly.mainnet': 'Mainnet',
        'watchOnly.chipnet': 'Chipnet',
        'watchOnly.accountXpub': 'Account xPub',
        'watchOnly.accountXpubHelp':
          'An account xPub is public information used to derive receive and change addresses. It cannot spend funds by itself.',
        'watchOnly.masterFingerprint': 'Master fingerprint',
        'watchOnly.optional': 'optional',
        'watchOnly.masterFingerprintHelp':
          'Optional public metadata that helps match this account to the signing device that exported it. It is not a private key.',
        'watchOnly.xpubPlaceholder': 'Paste the xPub exported by SeedCash',
        'watchOnly.scanCamera': 'Scan (camera)',
        'watchOnly.previewTitle': 'Public address preview',
      })[key] ?? key,
  }),
}));

vi.mock('../../../apis/WalletManager/WalletManager', () => ({
  default: () => ({ getWalletMetadata: vi.fn() }),
}));

vi.mock('../../../services/watchOnlyWallet', () => ({
  createWatchOnlyWallet: vi.fn(),
  WATCH_ONLY_WALLET_TYPE: 'watch-only',
}));

vi.mock('../../../utils/barcodeScanner', () => ({
  scanBarcodeSafely: vi.fn(),
}));

import WatchOnlyWalletPage from '../WatchOnlyWalletPage';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('WatchOnlyWalletPage', () => {
  it('provides contextual help for network, xPub, and fingerprint fields', () => {
    render(<WatchOnlyWalletPage />);

    const networkHelp = screen.getByRole('button', { name: 'Network' });
    const xpubHelp = screen.getByRole('button', { name: 'Account xPub' });
    const fingerprintHelp = screen.getByRole('button', {
      name: 'Master fingerprint',
    });

    expect(networkHelp).toHaveAttribute('aria-expanded', 'false');
    expect(xpubHelp).toHaveAttribute('aria-expanded', 'false');
    expect(fingerprintHelp).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(xpubHelp);

    expect(screen.getByRole('note')).toHaveTextContent(
      'It cannot spend funds by itself.'
    );
    expect(xpubHelp).toHaveAttribute('aria-expanded', 'true');
  });
});
