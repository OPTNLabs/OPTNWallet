import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { NostrSettings } from '../NostrSettings';
import { P2pFusionTransportPreview } from '../P2pFusionTransportPreview';
import { normalizeRelayDraft } from '../nostrRelayDraft';

describe('Nostr UI skeleton safety', () => {
  it('renders identity and relay controls as an explicit offline preview', () => {
    const html = renderToStaticMarkup(<NostrSettings />);

    expect(html).toContain('NIP-17 private chat');
    expect(html).toContain('UI preview');
    expect(html).toContain('does not generate a Nostr key');
    expect(html).toContain('never contacted');
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
