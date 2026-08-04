/** @vitest-environment jsdom */

import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  navigate: vi.fn(),
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

vi.mock('../../../../i18n/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) =>
      key === 'onboarding.missingWord' ? 'Word {number} is missing.' : key,
  }),
}));

vi.mock('../../../../apis/DatabaseManager/DatabaseService', () => ({
  default: () => ({ startDatabase: vi.fn().mockResolvedValue(true) }),
}));

vi.mock('../../../../platform/desktop/DesktopWalletManager', () => ({
  createWalletWithPassword: vi.fn(),
}));

vi.mock('../../../../services/KeyService', () => ({
  default: { bootstrapInitialAddressBatch: vi.fn() },
}));

import DesktopImportWalletPage from '../../onboarding/DesktopImportWalletPage';

const VALID_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('DesktopImportWalletPage UI', () => {
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
