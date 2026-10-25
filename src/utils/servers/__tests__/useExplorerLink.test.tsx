/** @vitest-environment jsdom */
import React from 'react';
import { renderHook } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { describe, expect, it } from 'vitest';

import preferencesReducer, {
  setChainPolicy,
} from '../../../state/slices/preferencesSlice';
import { Network } from '../../../state/slices/networkSlice';
import { useExplorerLink } from '../useExplorerLink';

const TXID = 'f'.repeat(64);

describe('useExplorerLink', () => {
  it('applies the selected chain policy to transaction links', () => {
    const store = configureStore({
      reducer: { preferences: preferencesReducer },
    });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <Provider store={store}>{children}</Provider>
    );

    const { result, rerender } = renderHook(() => useExplorerLink(), {
      wrapper,
    });
    expect(result.current.tx(Network.MAINNET, TXID)).toContain(
      `bchexplorer.cash/tx/${TXID}`
    );

    store.dispatch(setChainPolicy('own_infrastructure'));
    rerender();
    expect(result.current.tx(Network.MAINNET, TXID)).toBeNull();
    expect(result.current.reason).toContain('Settings → Explorer');
  });
});
