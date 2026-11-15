/** @vitest-environment jsdom */

import '@testing-library/jest-dom/vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import InfoButton from '../InfoButton';

afterEach(cleanup);

describe('InfoButton', () => {
  it('closes contextual help with Escape after it is opened', () => {
    render(
      <InfoButton
        id="status-help"
        ariaLabel="Status help"
        content="This explains the current status."
      />
    );

    const button = screen.getByRole('button', { name: 'Status help' });
    fireEvent.click(button);
    expect(screen.getByRole('note')).toHaveTextContent(
      'This explains the current status.'
    );
    expect(button).toHaveAttribute('aria-describedby');

    fireEvent.keyDown(button, { key: 'Escape' });

    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(button).not.toHaveAttribute('aria-describedby');
  });

  it('opens from a touch long press', async () => {
    render(
      <InfoButton
        id="long-press-help"
        ariaLabel="Explain state"
        content="This state is still being verified."
      />
    );

    const button = screen.getByRole('button', { name: 'Explain state' });
    fireEvent.pointerDown(button);
    await new Promise((resolve) => setTimeout(resolve, 550));
    fireEvent.pointerUp(button);

    expect(screen.getByRole('note')).toHaveTextContent(
      'This state is still being verified.'
    );
  });

  it('can open toward the right when the trigger is on the left side of a card', () => {
    render(
      <InfoButton
        id="left-card-help"
        ariaLabel="Explain card status"
        content="This card status is still being verified."
        popoverSide="right"
      />
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'Explain card status' })
    );

    expect(document.getElementById('left-card-help-info')).toHaveClass(
      'left-0',
      'right-auto'
    );
  });

  it('centers a card-level popover in an opaque portal', async () => {
    render(
      <InfoButton
        id="centered-card-help"
        ariaLabel="Explain centered card status"
        content="This card status is centered."
        popoverSide="center"
      />
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'Explain centered card status' })
    );

    await waitFor(() => {
      const note = document.getElementById('centered-card-help-info');
      expect(note).toHaveClass(
        'fixed',
        'left-1/2',
        'top-1/2',
        '-translate-x-1/2',
        '-translate-y-1/2',
        'max-h-[calc(100dvh-2rem)]',
        'overflow-y-auto'
      );
      expect(note).toHaveStyle({
        backgroundColor: 'var(--wallet-surface)',
      });
      expect(note?.parentElement).toBe(document.body);
    });
  });
});
