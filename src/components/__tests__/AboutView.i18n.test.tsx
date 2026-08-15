/** @vitest-environment jsdom */

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import preferencesReducer from '../../state/slices/preferencesSlice';
import { I18nProvider } from '../../i18n/I18nProvider';
import { LanguageSettings } from '../../features/settings/LanguageSettings';
import AboutView from '../AboutView';

vi.mock('../ContractDetails', () => ({
  default: () => null,
}));

afterEach(() => cleanup());

describe('AboutView localization', () => {
  it('applies the language selector to another mounted screen', () => {
    const testStore = configureStore({
      reducer: { preferences: preferencesReducer },
    });

    render(
      <Provider store={testStore}>
        <I18nProvider>
          <LanguageSettings />
          <AboutView />
        </I18nProvider>
      </Provider>
    );

    expect(screen.getByRole('heading', { name: 'Overview' })).toBeVisible();
    expect(screen.getByRole('combobox', { name: 'Language' })).toHaveClass(
      'wallet-language-select'
    );

    fireEvent.change(screen.getByRole('combobox', { name: 'Language' }), {
      target: { value: 'es' },
    });

    expect(
      screen.getByRole('heading', { name: 'Descripción general' })
    ).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Overview' })).toBeNull();
  });
});
