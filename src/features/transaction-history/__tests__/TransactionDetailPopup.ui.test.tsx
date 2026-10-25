/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import type { ReactNode } from 'react';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchDetails: vi.fn(),
  copyWithFeedback: vi.fn(),
  dispatch: vi.fn(),
  translate: (key: string) => key,
}));

vi.mock('react-redux', () => ({
  useDispatch: () => mocks.dispatch,
  useSelector: () => 7,
}));
vi.mock('../../../services/ElectrumService', () => ({
  default: { getTransactionDetails: mocks.fetchDetails },
}));
vi.mock('../../../apis/TransactionManager/TransactionManager', () => ({
  default: () => ({ applyConfirmedHeight: vi.fn() }),
}));
vi.mock('../../../utils/copyWithFeedback', () => ({
  copyWithFeedback: mocks.copyWithFeedback,
}));
vi.mock('../../../utils/servers/useExplorerLink', () => ({
  useExplorerLink: () => ({ reason: 'Explorer access is unavailable.' }),
}));
vi.mock('../../../i18n/useI18n', () => ({
  useI18n: () => ({ locale: 'en', t: mocks.translate }),
}));
vi.mock('../../../components/transaction/Popup', () => ({
  default: ({ children }: { children: ReactNode }) => (
    <div role="dialog">{children}</div>
  ),
}));

import TransactionDetailPopup from '../TransactionDetailPopup';

beforeEach(() => {
  mocks.fetchDetails.mockReset();
  mocks.copyWithFeedback.mockReset();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('announces detail lookup failures and retries the same transaction', async () => {
  mocks.fetchDetails
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce(null);
  render(
    <TransactionDetailPopup
      txid={'a'.repeat(64)}
      txHeight={0}
      explorerUrl={null}
      walletAddresses={new Set()}
      onClose={vi.fn()}
    />
  );

  await waitFor(() => expect(mocks.fetchDetails).toHaveBeenCalledOnce());
  expect(await screen.findByRole('alert')).toHaveTextContent('offline');
  const retry = screen.getByRole('button', { name: 'builder.tryAgain' });
  expect(retry).toHaveClass('min-h-[44px]');
  fireEvent.click(retry);
  await waitFor(() => expect(mocks.fetchDetails).toHaveBeenCalledTimes(2));
  expect(mocks.fetchDetails).toHaveBeenNthCalledWith(2, 'a'.repeat(64), {
    forceRefresh: true,
  });
});

it('copies the transaction ID from the header', async () => {
  mocks.fetchDetails.mockResolvedValue({
    inputs: [],
    outputs: [],
    confirmations: 0,
    height: 0,
  });
  render(
    <TransactionDetailPopup
      txid={'b'.repeat(64)}
      txHeight={0}
      explorerUrl={null}
      walletAddresses={new Set()}
      onClose={vi.fn()}
    />
  );

  fireEvent.click(
    await screen.findByRole('button', { name: 'history.copyTransaction' })
  );
  expect(mocks.copyWithFeedback).toHaveBeenCalledWith(
    'b'.repeat(64),
    'history.transactionCopied'
  );
});

it('shows the verified wallet net effect in transaction details', async () => {
  mocks.fetchDetails.mockResolvedValue({
    inputs: [{ address: 'wallet', amountSats: 20_000 }],
    outputs: [{ address: 'wallet', amountSats: 15_000 }],
    confirmations: 0,
    height: 0,
  });
  render(
    <TransactionDetailPopup
      txid={'d'.repeat(64)}
      txHeight={0}
      explorerUrl={null}
      walletAddresses={new Set(['wallet'])}
      onClose={vi.fn()}
    />
  );

  expect(await screen.findByText('-0.00005 BCH')).toBeInTheDocument();
});

it('explains unavailable explorer access and links to explorer settings', async () => {
  mocks.fetchDetails.mockResolvedValue({
    inputs: [],
    outputs: [],
    confirmations: 0,
    height: 0,
  });
  render(
    <MemoryRouter>
      <TransactionDetailPopup
        txid={'c'.repeat(64)}
        txHeight={0}
        explorerUrl={null}
        explorerReason="Explorer access is unavailable."
        walletAddresses={new Set()}
        onClose={vi.fn()}
      />
    </MemoryRouter>
  );

  expect(
    await screen.findByRole('link', { name: 'history.openExplorerSettings' })
  ).toHaveAttribute('href', '/settings?panel=explorer');
});
