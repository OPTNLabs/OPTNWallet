/** @vitest-environment jsdom */

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-dom', async () => {
  const actual = await vi.importActual<typeof import('react-dom')>('react-dom');
  return { ...actual, createPortal: (node: React.ReactNode) => node };
});

import Popup from '../Popup';

describe('Popup keyboard interaction', () => {
  it('moves focus into the dialog, traps Tab, closes on Escape and restores focus', async () => {
    const user = userEvent.setup();
    const close = vi.fn();
    const { rerender } = render(<button type="button">Open</button>);

    const open = screen.getByRole('button', { name: 'Open' });
    open.focus();
    rerender(
      <>
        <button type="button">Open</button>
        <Popup closePopups={close}>
          <button type="button">First action</button>
        </Popup>
      </>
    );
    const first = screen.getByRole('button', { name: 'First action' });
    const closeButton = screen.getByRole('button', { name: 'Close' });
    expect(document.activeElement).toBe(first);

    const latestClose = vi.fn();
    rerender(
      <>
        <button type="button">Open</button>
        <Popup closePopups={latestClose}>
          <button type="button">First action</button>
        </Popup>
      </>
    );
    expect(document.activeElement).toBe(first);

    await user.tab({ shift: true });
    expect(document.activeElement).toBe(closeButton);
    await user.tab();
    expect(document.activeElement).toBe(first);

    first.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(closeButton);
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(latestClose).toHaveBeenCalledOnce();

    rerender(
      <>
        <button type="button">Open</button>
      </>
    );
    expect(document.activeElement).toBe(open);
  });
});
