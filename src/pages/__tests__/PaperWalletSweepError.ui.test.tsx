/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import PaperWalletSweepError from '../PaperWalletSweepError';
import { I18nContext } from '../../i18n/I18nContext';

const renderError = (message: string, compact = false) =>
  render(
    <I18nContext.Provider
      value={{
        locale: 'en',
        setLocale: () => undefined,
        t: (key) => key,
      }}
    >
      <PaperWalletSweepError message={message} compact={compact} />
    </I18nContext.Provider>
  );

it('announces sweep errors in both the page and confirmation-sheet styles', () => {
  const { rerender } = renderError(
    'Broadcast failed. Check the transaction status.'
  );
  expect(screen.getByRole('alert')).toHaveTextContent('send.genericError');
  expect(screen.getByRole('alert').parentElement).toHaveClass('mt-3');
  expect(
    screen.getByText('Broadcast failed. Check the transaction status.')
  ).toBeInTheDocument();

  rerender(
    <I18nContext.Provider
      value={{
        locale: 'en',
        setLocale: () => undefined,
        t: (key) => key,
      }}
    >
      <PaperWalletSweepError
        message="Broadcast failed. Check the transaction status."
        compact
      />
    </I18nContext.Provider>
  );
  expect(screen.getByRole('alert').parentElement).not.toHaveClass('mt-3');
  expect(screen.getByText('send.technicalDetails')).toBeInTheDocument();
});
