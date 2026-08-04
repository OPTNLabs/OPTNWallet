/** @vitest-environment jsdom */

import React from 'react';
import { Provider } from 'react-redux';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import Bip44AccountPathFields from '../../../../components/Bip44AccountPathFields';
import { Network } from '../../../../state/slices/networkSlice';
import { I18nProvider } from '../../../../i18n/I18nProvider';
import { store } from '../../../../state/store';

afterEach(() => cleanup());

describe('Bip44AccountPathFields UI', () => {
  it('updates the canonical account path when the account index changes', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const onValidityChange = vi.fn();

    render(
      <Provider store={store}>
        <I18nProvider>
          <Bip44AccountPathFields
            network={Network.CHIPNET}
            value="m/44'/1'/0'"
            onChange={onChange}
            onValidityChange={onValidityChange}
          />
        </I18nProvider>
      </Provider>
    );

    const accountIndex = screen.getByRole('textbox', {
      name: 'BIP44 account index',
    });

    expect(accountIndex).toHaveValue('0');
    await user.clear(accountIndex);
    await user.type(accountIndex, '7');

    expect(onChange).toHaveBeenLastCalledWith("m/44'/1'/7'");
    expect(
      screen.getByText("m/44'/1'/7'", { exact: true })
    ).toBeInTheDocument();
    expect(onValidityChange).toHaveBeenLastCalledWith(true);
  });

  it('marks the path invalid while a required field is empty', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const onValidityChange = vi.fn();

    render(
      <Provider store={store}>
        <I18nProvider>
          <Bip44AccountPathFields
            network={Network.MAINNET}
            value="m/44'/145'/0'"
            onChange={onChange}
            onValidityChange={onValidityChange}
          />
        </I18nProvider>
      </Provider>
    );

    await user.clear(screen.getByRole('textbox', { name: 'BIP44 coin type' }));

    expect(screen.getByText('Coin type is required.')).toBeInTheDocument();
    expect(onValidityChange).toHaveBeenLastCalledWith(false);
    expect(onChange).not.toHaveBeenCalled();
  });
});
