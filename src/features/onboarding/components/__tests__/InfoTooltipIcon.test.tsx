/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import InfoTooltipIcon from '../InfoTooltipIcon';

describe('InfoTooltipIcon', () => {
  it('provides keyboard-accessible contextual help without showing it by default', () => {
    render(
      <InfoTooltipIcon
        id="recovery-help"
        content="Keep your recovery phrase offline."
      />
    );

    const button = screen.getByRole('button', { name: 'More information' });
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    expect(button).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(button);

    expect(screen.getByRole('note')).toHaveTextContent(
      'Keep your recovery phrase offline.'
    );
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(button).toHaveAttribute('aria-describedby');

    fireEvent.keyDown(button, { key: 'Escape' });
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(button).not.toHaveAttribute('aria-describedby');
  });
});
