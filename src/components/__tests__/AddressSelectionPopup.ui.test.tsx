import React from 'react';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import walletReducer, { setWalletId } from '../../state/slices/walletSlice';
import networkReducer from '../../state/slices/networkSlice';
import preferencesReducer from '../../state/slices/preferencesSlice';
import { I18nProvider } from '../../i18n/I18nProvider';

const { retrieveKeys } = vi.hoisted(() => ({ retrieveKeys: vi.fn() }));
vi.mock('../../services/KeyService', () => ({
  default: { retrieveKeys },
}));
vi.mock('react-dom', async () => {
  const actual = await vi.importActual<typeof import('react-dom')>('react-dom');
  return { ...actual, createPortal: (node: React.ReactNode) => node };
});

import AddressSelectionPopup from '../AddressSelectionPopup';

function renderAddressPicker(onSelect = vi.fn(), onClose = vi.fn()) {
  const store = configureStore({
    reducer: {
      wallet_id: walletReducer,
      network: networkReducer,
      preferences: preferencesReducer,
    },
  });
  store.dispatch(setWalletId(12));
  return {
    onSelect,
    onClose,
    ...render(
      <Provider store={store}>
        <I18nProvider>
          <AddressSelectionPopup onSelect={onSelect} onClose={onClose} />
        </I18nProvider>
      </Provider>
    ),
  };
}

describe('AddressSelectionPopup', () => {
  afterEach(cleanup);
  beforeEach(() => retrieveKeys.mockReset());

  it('announces loading, renders labeled address choices and selects without leaking the full value in labels', async () => {
    retrieveKeys.mockResolvedValue([
      { id: 1, address: 'bitcoincash:qz0exampleaddressforselectiontest' },
    ]);
    const onSelect = vi.fn();
    renderAddressPicker(onSelect);

    expect(screen.getByRole('status')).toBeTruthy();
    const dialog = await screen.findByRole('dialog', {
      name: 'Select Address',
    });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const choice = await screen.findByRole('button', {
      name: /Select Address:/,
    });
    expect(choice.getAttribute('aria-label')).not.toContain(
      'qz0exampleaddressforselectiontest'
    );
    expect(choice.className).toContain('min-h-[44px]');
    fireEvent.click(choice);
    expect(onSelect).toHaveBeenCalledWith(
      'bitcoincash:qz0exampleaddressforselectiontest'
    );
  });

  it('explains an empty wallet address list', async () => {
    retrieveKeys.mockResolvedValue([]);
    renderAddressPicker();
    expect(
      await screen.findByText(
        'No saved addresses are available in this wallet yet.'
      )
    ).toBeTruthy();
  });

  it('shows a retry after a load error and recovers to the empty state', async () => {
    retrieveKeys
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValueOnce([]);
    renderAddressPicker();
    expect(await screen.findByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
    await waitFor(() => {
      expect(retrieveKeys).toHaveBeenCalledTimes(2);
    });
    expect(
      await screen.findByText(
        'No saved addresses are available in this wallet yet.'
      )
    ).toBeTruthy();
  });
});
