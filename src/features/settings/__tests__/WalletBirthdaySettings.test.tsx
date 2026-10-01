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
import { afterEach, expect, it, vi } from 'vitest';
import { WalletBirthdaySettings } from '../WalletBirthdaySettings';
const mock = vi.hoisted(() => ({ invoke: vi.fn(), handle: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mock.invoke }));
vi.mock('../../../platform/desktop/engineWalletBridge', () => ({
  engineHandleFor: mock.handle,
}));
afterEach(cleanup);
it('confirms a birthday using the observed epoch, and surfaces a stale-session refusal', async () => {
  mock.handle.mockResolvedValue('wallet.optn');
  mock.invoke.mockReset();
  mock.invoke.mockResolvedValue({
    active: 'wallet.optn',
    epoch: 7,
    restore_birthday: { kind: 'unknown' },
    manual_rescan_from: 80,
  });
  render(<WalletBirthdaySettings walletId={1} />);
  await screen.findByText('Saved birthday: unknown — full history.');
  expect(
    screen.getByText('Manual rescan override: block 80.')
  ).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Wallet history start'), {
    target: { value: 'height' },
  });
  fireEvent.change(screen.getByLabelText('Earliest block'), {
    target: { value: '-1' },
  });
  expect(
    screen.getByRole('button', { name: 'Review birthday change' })
  ).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Earliest block'), {
    target: { value: '100' },
  });
  fireEvent.click(
    screen.getByRole('button', { name: 'Review birthday change' })
  );
  expect(mock.invoke).toHaveBeenCalledTimes(1);
  mock.invoke.mockRejectedValueOnce('Wallet session changed');
  fireEvent.click(
    screen.getByRole('button', { name: 'Confirm history start' })
  );
  await waitFor(() =>
    expect(mock.invoke).toHaveBeenLastCalledWith('optn_wallet_security', {
      request: {
        command: 'set_birthday',
        epoch: 7,
        birthday: { kind: 'height', height: 100 },
      },
    })
  );
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Wallet session changed'
  );
  expect(screen.queryByText(/History start saved/)).not.toBeInTheDocument();
  mock.invoke.mockResolvedValueOnce({
    active: 'wallet.optn',
    epoch: 7,
    restore_birthday: { kind: 'imported_at_height', height: 100 },
    manual_rescan_from: 80,
  });
  fireEvent.click(
    screen.getByRole('button', { name: 'Confirm history start' })
  );
  expect(
    await screen.findByText('Saved birthday: block 100.')
  ).toBeInTheDocument();
  expect(
    screen.getByText('Manual rescan override: block 80.')
  ).toBeInTheDocument();
});
it('does not permit changing a different runtime wallet', async () => {
  mock.handle.mockResolvedValue('wallet.optn');
  mock.invoke.mockResolvedValue({
    active: 'another.optn',
    epoch: 9,
    restore_birthday: { kind: 'unknown' },
  });
  render(<WalletBirthdaySettings walletId={1} />);
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Unlock this wallet'
  );
  expect(
    screen.getByRole('button', { name: 'Review birthday change' })
  ).toBeDisabled();
});
