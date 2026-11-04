/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { I18nContext } from '../../../i18n/I18nContext';
import MultisigError from '../MultisigError';

it('keeps technical multisig failures behind friendly copy and disclosure', () => {
  render(
    <I18nContext.Provider
      value={{
        locale: 'en',
        setLocale: () => undefined,
        t: (key) => key,
      }}
    >
      <MultisigError message="TypeError: failed to read policy metadata" />
    </I18nContext.Provider>
  );

  expect(screen.getByRole('alert')).toHaveTextContent('send.genericError');
  expect(screen.getByText('send.technicalDetails')).toBeInTheDocument();
  expect(
    screen.getByText('TypeError: failed to read policy metadata')
  ).toBeInTheDocument();
  expect(
    screen.getByText('send.technicalDetails').closest('summary')
  ).toHaveClass('min-h-[44px]');
});
