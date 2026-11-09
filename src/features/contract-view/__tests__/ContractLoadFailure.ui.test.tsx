/** @vitest-environment jsdom */
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import ContractLoadFailure from '../ContractLoadFailure';
import { I18nContext } from '../../../i18n/I18nContext';

it('announces a load error and exposes an accessible retry action', () => {
  const onRetry = vi.fn();
  render(
    <I18nContext.Provider
      value={{
        locale: 'en',
        setLocale: () => undefined,
        t: (key) => key,
      }}
    >
      <ContractLoadFailure
        message="Contract templates could not be loaded."
        technicalMessage="Electrum connection timed out"
        retryLabel="Try Again"
        onRetry={onRetry}
      />
    </I18nContext.Provider>
  );

  expect(screen.getByRole('alert')).toHaveTextContent(
    'Contract templates could not be loaded.'
  );
  expect(screen.getByText('send.technicalDetails')).toBeInTheDocument();
  expect(screen.getByText('Electrum connection timed out')).toBeInTheDocument();
  const retry = screen.getByRole('button', { name: 'Try Again' });
  expect(retry).toHaveClass('min-h-[44px]');
  fireEvent.click(retry);
  expect(onRetry).toHaveBeenCalledOnce();
});
