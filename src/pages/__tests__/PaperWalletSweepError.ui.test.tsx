/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import PaperWalletSweepError from '../PaperWalletSweepError';

it('announces sweep errors in both the page and confirmation-sheet styles', () => {
  const { rerender } = render(
    <PaperWalletSweepError message="Broadcast failed. Check the transaction status." />
  );
  expect(screen.getByRole('alert')).toHaveTextContent('Broadcast failed');
  expect(screen.getByRole('alert')).toHaveClass('mt-3');

  rerender(
    <PaperWalletSweepError
      message="Broadcast failed. Check the transaction status."
      compact
    />
  );
  expect(screen.getByRole('alert')).toHaveTextContent(
    'Check the transaction status'
  );
  expect(screen.getByRole('alert')).not.toHaveClass('mt-3');
});
