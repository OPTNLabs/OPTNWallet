/** @vitest-environment jsdom */
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ scanSingle: vi.fn() }));
vi.mock('react-dom', async () => {
  const actual = await vi.importActual<typeof import('react-dom')>('react-dom');
  return { ...actual, createPortal: (node: React.ReactNode) => node };
});
vi.mock('../QrTransport', () => ({
  createQrTransport: () => ({ scanSingle: mocks.scanSingle }),
}));

import { QrScanDialog } from '../QrScanDialog';

afterEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
});

it('announces scanner failures, keeps retry available, and allows safe cancellation', async () => {
  const user = userEvent.setup();
  const onFrame = vi.fn();
  const onClose = vi.fn();
  mocks.scanSingle.mockRejectedValueOnce(new Error('Camera permission denied'));
  render(
    <>
      <button type="button">Open scanner</button>
      <QrScanDialog onFrame={onFrame} onClose={onClose} />
    </>
  );

  const dialog = screen.getByRole('dialog', { name: 'Scan QR frame' });
  expect(dialog).toBeInTheDocument();
  expect(document.activeElement).toBe(
    screen.getByRole('button', { name: 'Scan frame' })
  );
  await user.click(screen.getByRole('button', { name: 'Scan frame' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Camera permission denied'
  );
  expect(screen.getByRole('button', { name: 'Scan frame' })).toBeEnabled();
  expect(onFrame).not.toHaveBeenCalled();

  await user.click(screen.getByRole('button', { name: 'Done' }));
  expect(onClose).toHaveBeenCalledOnce();
  expect(onFrame).not.toHaveBeenCalled();
});

it('does not pass an empty scanner result to the cosigner flow', async () => {
  const user = userEvent.setup();
  const onFrame = vi.fn();
  const onClose = vi.fn();
  mocks.scanSingle.mockResolvedValueOnce(null);
  render(<QrScanDialog onFrame={onFrame} onClose={onClose} />);

  await user.click(screen.getByRole('button', { name: 'Scan frame' }));
  expect(mocks.scanSingle).toHaveBeenCalledOnce();
  expect(onFrame).not.toHaveBeenCalled();
});
