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
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { OutboundTransactionRecord } from '../../../../services/OutboundTransactionTracker';

const mocks = vi.hoisted(() => ({
  record: {
    txid: 'a'.repeat(64),
    rawTx: '00',
    walletId: 7,
    source: 'cashfusion',
    sourceLabel: 'CashFusion',
    privacyRoute: 'tor-only',
    recipientSummary: `bchtest:${'q'.repeat(42)}`,
    state: 'submitted',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    spentOutpoints: [],
    verificationPending: true,
    verificationMessage: 'Wallet sync has not confirmed this transaction.',
  } as OutboundTransactionRecord,
  release: vi.fn(),
  canClear: vi.fn(() => false),
}));

vi.mock('react-redux', () => ({ useSelector: () => 7 }));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('../../../../state/slices/walletSlice', () => ({
  selectWalletId: () => 7,
}));
vi.mock('../../../../hooks/useOutboundTransactions', () => ({
  default: () => ({
    outboundTransactions: [mocks.record],
    canClear: () => mocks.canClear(),
    reconciling: false,
    refresh: vi.fn(),
    release: mocks.release,
  }),
}));
vi.mock('../../../../utils/copyWithFeedback', () => ({
  copyWithFeedback: vi.fn(),
}));
vi.mock('../../../../i18n/useI18n', () => ({
  useI18n: () => ({
    t: (key: string, values?: { age?: string }) =>
      key === 'outbox.updated' ? `Updated ${values?.age}` : key,
  }),
}));

import Outbox from '../../../../pages/Outbox';
import { WalletConfirmProvider } from '../../../../components/WalletConfirmDialog';

function renderOutbox() {
  return render(
    <WalletConfirmProvider>
      <Outbox />
    </WalletConfirmProvider>
  );
}

afterEach(cleanup);
beforeEach(() => {
  mocks.release.mockReset();
  mocks.canClear.mockReturnValue(false);
  mocks.record.source = 'cashfusion';
  mocks.record.privacyRoute = 'tor-only';
  mocks.record.state = 'submitted';
  mocks.record.verificationPending = true;
  mocks.record.lastError = null;
  mocks.record.verificationMessage =
    'Wallet sync has not confirmed this transaction.';
});

it('explains why Fusion inputs remain locked and exposes that reason to assistive technology', () => {
  renderOutbox();

  const releaseAction = screen.getByRole('button', {
    name: 'outbox.awaitingVerification',
  });
  expect(releaseAction).toBeDisabled();
  expect(releaseAction).toHaveClass('min-h-[44px]');
  const descriptionId = releaseAction.getAttribute('aria-describedby');
  expect(descriptionId).toBeTruthy();
  expect(document.getElementById(descriptionId!)).toHaveTextContent(
    'outbox.verificationWaitDescription'
  );
  expect(
    screen.getByText('outbox.fusionVerificationPending')
  ).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'outbox.copyTxid' })).toHaveClass(
    'min-h-[44px]'
  );
  expect(screen.getByRole('button', { name: 'home.sync' })).toHaveClass(
    'min-h-[44px]'
  );
  expect(
    screen.getByRole('button', { name: 'outbox.destination' })
  ).toHaveTextContent(/^bcht\*+qqqq$/);
  fireEvent.click(
    screen.getByRole('button', { name: 'outbox.stateHelpLabel' })
  );
  expect(screen.getByRole('note')).toHaveTextContent(
    'outbox.verificationWaitDescription'
  );
  expect(mocks.release).not.toHaveBeenCalled();
});

it('requires confirmation before releasing a clearable outbox record', async () => {
  mocks.record.source = 'wallet';
  mocks.record.privacyRoute = 'default';
  mocks.record.verificationPending = false;
  mocks.canClear.mockReturnValue(true);
  renderOutbox();

  const clearButton = screen.getByRole('button', {
    name: 'outbox.clearPending',
  });
  fireEvent.click(clearButton);
  fireEvent.click(clearButton);

  expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
  expect(screen.getByRole('alertdialog')).toHaveTextContent(
    'outbox.clearPendingTitle'
  );
  fireEvent.click(screen.getByRole('button', { name: 'confirm.ok' }));

  await waitFor(() => {
    expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(mocks.release).toHaveBeenCalledWith(mocks.record.txid);
  });
});

it('keeps the network-visible state vocabulary and explanation together', () => {
  mocks.record.source = 'wallet';
  mocks.record.privacyRoute = 'default';
  mocks.record.verificationPending = false;
  mocks.record.state = 'broadcasted';
  mocks.canClear.mockReturnValue(false);
  renderOutbox();

  expect(screen.getByText('outbox.stateBroadcasted')).toBeInTheDocument();
  const releaseAction = screen.getByRole('button', {
    name: 'outbox.releaseStale',
  });
  expect(releaseAction).toBeDisabled();
  fireEvent.click(
    screen.getByRole('button', { name: 'outbox.stateHelpLabel' })
  );
  expect(screen.getByRole('note')).toHaveTextContent(
    'outbox.stateBroadcastedHelp'
  );
});

it.each([
  ['broadcasting', 'outbox.stateBroadcasting', 'outbox.stateBroadcastingHelp'],
  ['submitted', 'outbox.stateSubmitted', 'outbox.stateSubmittedHelp'],
  ['seen', 'outbox.stateSeen', 'outbox.stateSeenHelp'],
] as const)('explains the %s Outbox state', (state, label, help) => {
  mocks.record.source = 'wallet';
  mocks.record.privacyRoute = 'default';
  mocks.record.verificationPending = false;
  mocks.record.state = state;
  renderOutbox();

  expect(screen.getByText(label)).toBeInTheDocument();
  fireEvent.click(
    screen.getByRole('button', { name: 'outbox.stateHelpLabel' })
  );
  expect(screen.getByRole('note')).toHaveTextContent(help);
});

it('keeps provider diagnostics behind friendly Outbox copy', () => {
  mocks.record.source = 'wallet';
  mocks.record.privacyRoute = 'default';
  mocks.record.state = 'submitted';
  mocks.record.verificationPending = false;
  mocks.record.verificationMessage = null;
  mocks.record.lastError = 'connection timeout while querying the server';
  renderOutbox();

  expect(screen.getByText('send.networkError')).toBeInTheDocument();
  const technicalDetails = screen.getByText('send.technicalDetails');
  expect(technicalDetails).toBeInTheDocument();
  expect(technicalDetails.closest('summary')).toHaveClass('min-h-[44px]');
  expect(
    screen.getByText('connection timeout while querying the server')
  ).toBeInTheDocument();
});
