import React from 'react';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Network } from '../../state/slices/networkSlice';
import walletReconfigurationReducer, {
  beginWalletReconfiguration,
  failWalletReconfiguration,
  setWalletReconfigurationStage,
} from '../../state/slices/walletReconfigurationSlice';
import WalletReconfigurationOverlay from '../WalletReconfigurationOverlay';
import preferencesReducer from '../../state/slices/preferencesSlice';
import { I18nProvider } from '../../i18n/I18nProvider';

function renderOverlay(
  operation: 'running' | 'error',
  configure: (store: ReturnType<typeof createStore>) => void
) {
  const store = createStore();
  store.dispatch(
    operation === 'running'
      ? beginWalletReconfiguration({
          kind: 'network-switch',
          targetNetwork: Network.CHIPNET,
        })
      : failWalletReconfiguration('The network server is unavailable.')
  );
  configure(store);
  return renderToStaticMarkup(
    <Provider store={store}>
      <I18nProvider>
        <WalletReconfigurationOverlay />
      </I18nProvider>
    </Provider>
  );
}

function createStore() {
  return configureStore({
    reducer: {
      walletReconfiguration: walletReconfigurationReducer,
      preferences: preferencesReducer,
    },
  });
}

describe('WalletReconfigurationOverlay', () => {
  it('shows the current stage and blocks the user-facing flow during a switch', () => {
    const html = renderOverlay('running', (store) => {
      store.dispatch(setWalletReconfigurationStage('syncing'));
    });

    expect(html).toContain('Switching network');
    expect(html).toContain('Moving to Chipnet');
    expect(html).toContain('Synchronizing wallet');
    expect(html).toContain('Step 4 of 4');
    expect(html).toContain('Navigation is temporarily disabled');
    expect(html).toContain('aria-modal="true"');
  });

  it('shows a dismissible error instead of leaving the app looking busy', () => {
    const html = renderOverlay('error', () => {});

    expect(html).toContain('Wallet update failed');
    expect(html).toContain('The network server is unavailable.');
    expect(html).toContain('Dismiss');
  });
});
