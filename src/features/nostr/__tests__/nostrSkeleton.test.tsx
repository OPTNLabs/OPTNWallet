import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { describe, expect, it } from 'vitest';

import { NostrSettings } from '../NostrSettings';
import { P2pFusionTransportPreview } from '../P2pFusionTransportPreview';
import { normalizeRelayDraft } from '../nostrRelayDraft';
import experimentalReducer from '../../../state/slices/experimentalSlice';

function renderWithStore(ui: React.ReactElement) {
  const store = configureStore({
    reducer: {
      experimental: experimentalReducer,
      wallet_id: (state = { currentWalletId: 0 }) => state,
    },
  });
  return renderToStaticMarkup(<Provider store={store}>{ui}</Provider>);
}

describe('Nostr UI safety', () => {
  it('chat is off by default: shows the toggle, hides identity/relays until enabled', () => {
    const html = renderWithStore(<NostrSettings />);

    // The enable toggle is present…
    expect(html).toContain('Nostr chat');
    expect(html).toContain('End-to-end encrypted DMs');
    // …but with chat off by default, the identity + relay controls are not rendered.
    expect(html).not.toContain('Nostr identity');
    expect(html).not.toContain('wss://');
  });

  it('renders P2P Fusion with a disabled start action', () => {
    const html = renderToStaticMarkup(<P2pFusionTransportPreview />);

    expect(html).toContain('P2P Fusion over Nostr');
    expect(html).toContain('Start P2P round · unavailable');
    expect(html).toContain('disabled');
    expect(html).toContain('No round can start');
  });

  it('accepts only secure websocket relay drafts', () => {
    expect(normalizeRelayDraft('wss://relay.example.com/')).toBe(
      'wss://relay.example.com'
    );
    expect(normalizeRelayDraft('ws://relay.example.com')).toBeNull();
    expect(normalizeRelayDraft('https://relay.example.com')).toBeNull();
  });
});
