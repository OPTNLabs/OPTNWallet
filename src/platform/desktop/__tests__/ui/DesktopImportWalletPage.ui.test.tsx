/** @vitest-environment jsdom */

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
  create: vi.fn(),
  rollback: vi.fn(),
  bootstrap: vi.fn(),
  engine: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('react-redux', () => ({
  useDispatch: () => mocks.dispatch,
  useSelector: (selector: (state: unknown) => unknown) =>
    selector({
      wallet_id: { currentWalletId: 0 },
      network: { currentNetwork: 'mainnet' },
      appLock: { autoLockMinutes: 30 },
    }),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => mocks.navigate,
}));

vi.mock('../../../../i18n/useI18n', () => ({
  useI18n: () => ({
    locale: 'en',
    t: (key: string) =>
      key === 'onboarding.missingWord' ? 'Word {number} is missing.' : key,
  }),
}));

vi.mock('../../../../apis/DatabaseManager/DatabaseService', () => ({
  default: () => ({ startDatabase: vi.fn().mockResolvedValue(true) }),
}));

vi.mock('../../../../platform/desktop/DesktopWalletManager', () => ({
  createWalletWithPassword: mocks.create,
  rollbackCreatedWallet: mocks.rollback,
}));

vi.mock('../../../../services/KeyService', () => ({
  default: { bootstrapInitialAddressBatch: mocks.bootstrap },
}));

vi.mock('../../engineWalletBridge', () => ({
  openWalletInEngine: mocks.engine,
}));
vi.mock('../../toast', () => ({ Toast: { show: mocks.toast } }));
vi.mock('../../../../apis/ElectrumServer/ElectrumServer', () => ({
  default: () => ({ ensureFreshConnection: async () => {} }),
}));

import DesktopImportWalletPage from '../../onboarding/DesktopImportWalletPage';

const VALID_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('DesktopImportWalletPage UI', () => {
  beforeEach(() => {
    mocks.create.mockReset().mockResolvedValue(42);
    mocks.bootstrap.mockReset().mockResolvedValue(undefined);
    mocks.engine.mockReset().mockResolvedValue({ opened: true });
    mocks.toast.mockReset().mockResolvedValue(undefined);
  });

  it.each([0, 4])(
    'hands off imported account %s after bootstrap and keeps import success on engine failure',
    async (accountIndex) => {
      mocks.engine.mockResolvedValueOnce({
        opened: false,
        reason: 'HD inventory import failed.',
      });
      if (accountIndex === 4)
        mocks.toast.mockRejectedValueOnce(new Error('toast unavailable'));
      const user = userEvent.setup();
      render(<DesktopImportWalletPage />);
      const words = screen.getAllByRole('textbox');
      VALID_MNEMONIC.split(' ').forEach((word, index) => {
        fireEvent.change(words[index], { target: { value: word } });
      });
      await user.click(
        screen.getByRole('button', { name: 'onboarding.continue' })
      );
      if (accountIndex !== 0) {
        await user.click(
          screen.getByRole('checkbox', { name: 'derivation.customize' })
        );
        fireEvent.change(
          screen.getByRole('textbox', { name: 'derivation.bip44AccountIndex' }),
          {
            target: { value: String(accountIndex) },
          }
        );
      }
      await user.click(
        screen.getByRole('button', { name: 'onboarding.continue' })
      );
      await user.type(
        screen.getByPlaceholderText('onboarding.walletNamePlaceholder'),
        'Imported fixture'
      );
      await user.type(
        screen.getByPlaceholderText('onboarding.passwordPlaceholder'),
        'synthetic-password'
      );
      await user.type(
        screen.getByPlaceholderText('onboarding.confirmPasswordPlaceholder'),
        'synthetic-password'
      );
      await user.click(
        screen.getByRole('button', { name: 'onboarding.importWallet' })
      );
      await waitFor(() =>
        expect(mocks.navigate).toHaveBeenCalledWith('/home/42')
      );
      expect(mocks.create).toHaveBeenCalledWith(
        expect.objectContaining({
          derivationPath: `m/44'/145'/${accountIndex}'`,
          password: 'synthetic-password',
        })
      );
      expect(mocks.bootstrap).toHaveBeenNthCalledWith(1, 42, accountIndex, 1);
      expect(mocks.bootstrap).toHaveBeenNthCalledWith(2, 42, accountIndex, 20);
      expect(mocks.engine).toHaveBeenCalledExactlyOnceWith(
        42,
        'synthetic-password',
        30
      );
      expect(mocks.bootstrap.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.engine.mock.invocationCallOrder[0]
      );
      expect(mocks.engine.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.navigate.mock.invocationCallOrder[0]
      );
      expect(mocks.toast).toHaveBeenCalledWith({
        text: 'HD inventory import failed.',
        duration: 'long',
      });
      expect(mocks.rollback).not.toHaveBeenCalled();
    }
  );

  it('changes the phrase length and focuses the first missing word', async () => {
    const user = userEvent.setup();
    render(<DesktopImportWalletPage />);

    const wordCount = screen.getByRole('combobox', {
      name: 'onboarding.wordCountLabel',
    });
    expect(screen.getAllByRole('textbox')).toHaveLength(12);

    await user.selectOptions(wordCount, '24');
    expect(screen.getAllByRole('textbox')).toHaveLength(24);

    await user.click(
      screen.getByRole('button', { name: 'onboarding.continue' })
    );
    expect(screen.getByText('Word 1 is missing.')).toBeInTheDocument();
  });

  it.each([
    ['accepts a valid checksum', VALID_MNEMONIC],
    [
      'rejects an invalid checksum',
      VALID_MNEMONIC.replace(/about$/, 'abandon'),
    ],
  ])('%s before advancing to wallet setup', async (caseName, phrase) => {
    const user = userEvent.setup();
    render(<DesktopImportWalletPage />);

    const inputs = screen.getAllByRole('textbox');
    phrase.split(' ').forEach((word, index) => {
      fireEvent.change(inputs[index], { target: { value: word } });
    });

    await user.click(
      screen.getByRole('button', { name: 'onboarding.continue' })
    );

    if (caseName === 'accepts a valid checksum') {
      expect(
        screen.getByRole('heading', { name: 'onboarding.walletSetup' })
      ).toBeInTheDocument();
    } else {
      expect(
        screen.getByText('onboarding.invalidMnemonic')
      ).toBeInTheDocument();
    }
  });
});
