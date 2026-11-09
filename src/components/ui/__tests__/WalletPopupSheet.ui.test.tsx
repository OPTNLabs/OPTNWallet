/** @vitest-environment jsdom */

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-dom', async () => {
  const actual = await vi.importActual<typeof import('react-dom')>('react-dom');
  return { ...actual, createPortal: (node: React.ReactNode) => node };
});

import WalletPopupSheet from '../WalletPopupSheet';

describe('WalletPopupSheet keyboard interaction', () => {
  it('keeps focus in the modal across rerenders and restores it after Escape', async () => {
    const user = userEvent.setup();
    const dismiss = vi.fn();
    const { rerender } = render(
      <>
        <button type="button">Open request</button>
      </>
    );
    const trigger = screen.getByRole('button', { name: 'Open request' });
    trigger.focus();

    const renderSheet = (onDismiss: () => void) =>
      rerender(
        <>
          <button type="button">Open request</button>
          <WalletPopupSheet
            onDismiss={onDismiss}
            dismissLabel="Reject"
            footer={<button type="button">Approve</button>}
          >
            <button type="button">Details</button>
          </WalletPopupSheet>
        </>
      );

    renderSheet(dismiss);
    const close = screen.getByRole('button', { name: 'Reject' });
    const approve = screen.getByRole('button', { name: 'Approve' });
    expect(document.activeElement).toBe(close);

    const latestDismiss = vi.fn();
    renderSheet(latestDismiss);
    expect(document.activeElement).toBe(close);

    await user.tab({ shift: true });
    expect(document.activeElement).toBe(approve);
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(latestDismiss).toHaveBeenCalledOnce();

    rerender(
      <>
        <button type="button">Open request</button>
      </>
    );
    expect(document.activeElement).toBe(trigger);
  });
});
