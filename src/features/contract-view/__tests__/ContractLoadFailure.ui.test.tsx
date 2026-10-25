/** @vitest-environment jsdom */
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import ContractLoadFailure from '../ContractLoadFailure';

it('announces a load error and exposes an accessible retry action', () => {
  const onRetry = vi.fn();
  render(
    <ContractLoadFailure
      message="Contract templates could not be loaded."
      retryLabel="Try Again"
      onRetry={onRetry}
    />
  );

  expect(screen.getByRole('alert')).toHaveTextContent(
    'Contract templates could not be loaded.'
  );
  const retry = screen.getByRole('button', { name: 'Try Again' });
  expect(retry).toHaveClass('min-h-[44px]');
  fireEvent.click(retry);
  expect(onRetry).toHaveBeenCalledOnce();
});
