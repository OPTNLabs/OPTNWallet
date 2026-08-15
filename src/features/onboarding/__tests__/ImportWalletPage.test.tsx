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
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  navigate: vi.fn(),
  toast: vi.fn().mockResolvedValue(undefined),
  checkAccount: vi.fn().mockResolvedValue(false),
  createWallet: vi.fn().mockResolvedValue(true),
  setWalletId: vi.fn().mockResolvedValue(7),
  getWalletMetadata: vi.fn().mockResolvedValue({
    walletType: 'standard',
    networkType: 'mainnet',
    derivation_path: "m/44'/145'/0'",
    derivation_path_source: 'default',
  }),
  bootstrapInitialAddressBatch: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@capacitor/toast', () => ({
  Toast: { show: mocks.toast },
}));

vi.mock('react-redux', () => ({
  useDispatch: () => mocks.dispatch,
  useSelector: (selector: (state: unknown) => unknown) =>
    selector({
      wallet_id: { currentWalletId: 0 },
      network: { currentNetwork: 'mainnet' },
    }),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => mocks.navigate,
}));

vi.mock('../../../i18n/useI18n', () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, string | number>) => {
      const messages: Record<string, string> = {
        'onboarding.importWallet': 'Import Wallet',
        'onboarding.invalidMnemonic':
          'Recovery phrase checksum is invalid. Check the words and their order.',
        'onboarding.missingWord': 'Word {number} is missing.',
      };
      let message = messages[key] ?? key;
      for (const [name, value] of Object.entries(values ?? {})) {
        message = message.replace(`{${name}}`, String(value));
      }
      return message;
    },
  }),
}));

vi.mock('../../../apis/DatabaseManager/DatabaseService', () => ({
  default: () => ({ startDatabase: vi.fn().mockResolvedValue(true) }),
}));

vi.mock('../../../apis/WalletManager/WalletManager', () => ({
  default: () => ({
    checkAccount: mocks.checkAccount,
    createWallet: mocks.createWallet,
    setWalletId: mocks.setWalletId,
    getWalletMetadata: mocks.getWalletMetadata,
  }),
}));

vi.mock('../../../services/KeyService', () => ({
  default: {
    bootstrapInitialAddressBatch: mocks.bootstrapInitialAddressBatch,
  },
}));

vi.mock('../../../apis/ElectrumServer/ElectrumServer', () => ({
  default: () => ({
    ensureFreshConnection: vi.fn().mockResolvedValue(undefined),
  }),
}));

import ImportWalletPage from '../ImportWalletPage';

const VALID_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

function enterPhrase(phrase: string): void {
  phrase.split(' ').forEach((word, index) => {
    fireEvent.change(screen.getAllByRole('textbox')[index], {
      target: { value: word },
    });
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ImportWalletPage', () => {
  it('imports a valid mnemonic and navigates to the wallet', async () => {
    const user = userEvent.setup();
    render(<ImportWalletPage />);
    enterPhrase(VALID_MNEMONIC);

    await user.click(screen.getByRole('button', { name: 'Import Wallet' }));

    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith('/home/7'));
    expect(mocks.createWallet).toHaveBeenCalledTimes(1);
    expect(mocks.bootstrapInitialAddressBatch).toHaveBeenCalledWith(7, 0, 20);
  });

  it('keeps checksum failures visible instead of only flashing a toast', async () => {
    const user = userEvent.setup();
    render(<ImportWalletPage />);
    enterPhrase(VALID_MNEMONIC.replace(/about$/, 'abandon'));

    await user.click(screen.getByRole('button', { name: 'Import Wallet' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Recovery phrase checksum is invalid'
    );
    expect(mocks.createWallet).not.toHaveBeenCalled();
  });

  it('opens the wallet when background address bootstrap fails', async () => {
    const user = userEvent.setup();
    mocks.bootstrapInitialAddressBatch.mockRejectedValueOnce(
      new Error('address bootstrap unavailable')
    );
    render(<ImportWalletPage />);
    enterPhrase(VALID_MNEMONIC);

    await user.click(screen.getByRole('button', { name: 'Import Wallet' }));

    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith('/home/7'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
