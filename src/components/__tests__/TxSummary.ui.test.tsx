/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('../../i18n/useI18n', () => ({
  useI18n: () => ({
    locale: 'en',
    t: (key: string) => key,
  }),
}));
vi.mock('../../utils/copyWithFeedback', () => ({
  copyWithFeedback: vi.fn(),
}));

import TxSummary from '../confirm/TxSummary';

afterEach(cleanup);

it('masks technical IDs and addresses while retaining contextual disclosure', () => {
  const txid = 'a'.repeat(64);
  const address = `bitcoincash:${'q'.repeat(42)}`;

  render(
    <TxSummary
      inputsRaw={[{ tx_hash: txid, tx_pos: 1, value: 1000 }]}
      outputsRaw={[{ recipientAddress: address, amount: 900 }]}
    />
  );

  const txidTrigger = screen.getByRole('button', {
    name: 'history.transactionId',
  });
  expect(txidTrigger).not.toHaveTextContent(txid);
  fireEvent.contextMenu(txidTrigger);
  const dialogs = screen.getAllByRole('dialog');
  expect(dialogs[dialogs.length - 1]).toHaveTextContent(txid);

  const addressTrigger = screen.getByRole('button', {
    name: 'receive.copyAddress',
  });
  expect(addressTrigger).not.toHaveTextContent(address);
});
