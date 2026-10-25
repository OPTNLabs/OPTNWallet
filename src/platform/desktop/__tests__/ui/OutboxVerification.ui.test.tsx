/** @vitest-environment jsdom */
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { OutboundTransactionRecord } from '../../../../services/OutboundTransactionTracker';

const mocks = vi.hoisted(() => ({
  record: {
    txid: 'a'.repeat(64),
    rawTx: '00',
    walletId: 7,
    source: 'cashfusion',
    sourceLabel: 'CashFusion',
    privacyRoute: 'tor-only',
    state: 'submitted',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    spentOutpoints: [],
    verificationPending: true,
    verificationMessage: 'Wallet sync has not confirmed this transaction.',
  } as OutboundTransactionRecord,
  release: vi.fn(),
}));

vi.mock('react-redux', () => ({ useSelector: () => 7 }));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('../../../../state/slices/walletSlice', () => ({
  selectWalletId: () => 7,
}));
vi.mock('../../../../hooks/useOutboundTransactions', () => ({
  default: () => ({
    outboundTransactions: [mocks.record],
    canClear: () => false,
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

afterEach(cleanup);

it('explains why Fusion inputs remain locked and exposes that reason to assistive technology', () => {
  render(<Outbox />);

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
  expect(mocks.release).not.toHaveBeenCalled();
});
