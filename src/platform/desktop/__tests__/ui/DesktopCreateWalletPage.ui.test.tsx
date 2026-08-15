/** @vitest-environment jsdom */

import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  navigate: vi.fn(),
  generateMnemonic: vi.fn(),
  bootstrapInitialAddressBatch: vi.fn(),
  createWalletWithPassword: vi.fn(),
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

vi.mock('../../../../i18n/useI18n', () => ({
  useI18n: () => ({
    locale: 'en',
    t: (key: string) => key,
  }),
}));

vi.mock('../../../../apis/DatabaseManager/DatabaseService', () => ({
  default: () => ({ startDatabase: vi.fn().mockResolvedValue(true) }),
}));

vi.mock('../../../../services/KeyService', () => ({
  default: {
    generateMnemonic: mocks.generateMnemonic,
    bootstrapInitialAddressBatch: mocks.bootstrapInitialAddressBatch,
  },
}));

vi.mock('../../../../platform/desktop/DesktopWalletManager', () => ({
  createWalletWithPassword: mocks.createWalletWithPassword,
}));

import DesktopCreateWalletPage from '../../onboarding/DesktopCreateWalletPage';

const MNEMONIC =
  'abandon ability able about above absent absorb abstract absurd abuse access accident';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('DesktopCreateWalletPage UI', () => {
  beforeEach(() => {
    mocks.generateMnemonic.mockResolvedValue(MNEMONIC);
    mocks.bootstrapInitialAddressBatch.mockResolvedValue(undefined);
    mocks.createWalletWithPassword.mockResolvedValue(42);
  });

  it('requires seed confirmation and validates wallet details before creating', async () => {
    const user = userEvent.setup();
    vi.spyOn(Math, 'random')
      .mockReturnValueOnce(0.01)
      .mockReturnValueOnce(0.1)
      .mockReturnValueOnce(0.2);

    render(<DesktopCreateWalletPage />);

    expect(
      await screen.findByRole('heading', { name: 'onboarding.seedTitle' })
    ).toBeInTheDocument();
    expect(screen.getByText('abandon')).toBeInTheDocument();

    await user.click(
      screen.getByRole('button', { name: 'onboarding.wroteItDown' })
    );
    const confirmationInputs = screen.getAllByRole('textbox');
    expect(confirmationInputs).toHaveLength(3);

    await user.type(confirmationInputs[0], 'wrong');
    await user.type(confirmationInputs[1], 'ability');
    await user.type(confirmationInputs[2], 'able');
    await user.click(
      screen.getByRole('button', { name: 'onboarding.confirm' })
    );
    expect(screen.getByText('onboarding.confirmError')).toBeInTheDocument();

    await user.clear(confirmationInputs[0]);
    await user.type(confirmationInputs[0], 'abandon');
    await user.click(
      screen.getByRole('button', { name: 'onboarding.confirm' })
    );
    expect(
      screen.getByRole('heading', { name: 'onboarding.walletSetup' })
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole('button', { name: 'onboarding.continue' })
    );
    expect(
      screen.getByRole('heading', { name: 'onboarding.nameWallet' })
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole('button', { name: 'onboarding.createWallet' })
    );
    expect(screen.getByText('onboarding.nameRequired')).toBeInTheDocument();

    await user.type(
      screen.getByPlaceholderText('onboarding.walletNamePlaceholder'),
      '  Test Wallet  '
    );
    await user.type(
      screen.getByPlaceholderText('onboarding.passwordPlaceholder'),
      'first-password'
    );
    await user.type(
      screen.getByPlaceholderText('onboarding.confirmPasswordPlaceholder'),
      'different-password'
    );
    await user.click(
      screen.getByRole('button', { name: 'onboarding.createWallet' })
    );
    expect(screen.getByText('onboarding.passwordMismatch')).toBeInTheDocument();

    await user.clear(
      screen.getByPlaceholderText('onboarding.confirmPasswordPlaceholder')
    );
    await user.type(
      screen.getByPlaceholderText('onboarding.confirmPasswordPlaceholder'),
      'first-password'
    );
    await user.click(
      screen.getByRole('button', { name: 'onboarding.createWallet' })
    );

    expect(mocks.createWalletWithPassword).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Test Wallet',
        mnemonic: MNEMONIC,
        password: 'first-password',
        network: 'mainnet',
        derivationPath: "m/44'/145'/0'",
      })
    );
    expect(mocks.bootstrapInitialAddressBatch).toHaveBeenCalledWith(42, 0, 20);
    expect(mocks.navigate).toHaveBeenCalledWith('/home/42');
  });
});
