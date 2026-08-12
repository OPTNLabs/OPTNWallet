import React from 'react';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { CashFusionSettings } from '../CashFusionSettings';
import experimentalReducer, {
  setCashFusionEnabled,
  setP2pFusionEnabled,
} from '../../../state/slices/experimentalSlice';

describe('CashFusion settings mode enforcement', () => {
  it('mutes and disables the server Fuse Now card in P2P mode', () => {
    const store = configureStore({
      reducer: {
        experimental: experimentalReducer,
        wallet_id: (state = { currentWalletId: 7 }) => state,
        network: (state = { currentNetwork: 'chipnet' }) => state,
        utxos: (state = { utxos: {} }) => state,
      },
    });
    store.dispatch(setCashFusionEnabled(true));
    store.dispatch(setP2pFusionEnabled(true));

    const html = renderToStaticMarkup(
      <Provider store={store}>
        <CashFusionSettings />
      </Provider>
    );
    const serverCardStart = html.indexOf('aria-disabled="true"');
    const p2pCardStart = html.indexOf('P2P Fusion over Nostr');
    const serverCard = html.slice(serverCardStart, p2pCardStart);

    expect(serverCardStart).toBeGreaterThan(-1);
    expect(serverCard).toContain('opacity-40 grayscale');
    expect(serverCard).toContain('disabled=""');
    expect(serverCard).toContain('Fuse Now using CashFusion server');
  });
});
