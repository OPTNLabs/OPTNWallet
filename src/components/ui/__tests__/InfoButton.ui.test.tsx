/** @vitest-environment jsdom */

import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import InfoButton from '../InfoButton';

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
});
