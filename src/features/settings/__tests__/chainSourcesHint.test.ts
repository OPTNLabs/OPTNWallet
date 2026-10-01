/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';
import { refusedForWantOfTor } from '../chainSourceStatus';
import type { ChainSource } from '../../../platform/desktop/chainSourcesBridge';

const source = (errors: string[]): ChainSource => ({
  id: 'host:a.example',
  label: 'a.example',
  origin: 'user',
  group: null,
  disposition: 'enabled',
  priority: 0,
  can_remove: true,
  endpoints: [],
  capabilities: [],
  role: 'primary',
  live_protocols: [],
  failures: errors.map((error) => ({
    protocol: 'electrum',
    endpoint: { kind: 'electrum-tls', host: 'a.example', port: 50002 },
    error,
  })),
});

describe('chain source refusals', () => {
  it('names Tor only when every refusal is about Tor', () => {
    expect(
      refusedForWantOfTor([
        source([
          'remote native chain route requires a verified Tor SOCKS proxy',
        ]),
      ])
    ).toBe(true);

    // A server that is simply down must not be explained as a Tor problem:
    // starting Tor would not fix it, and the real error is already shown.
    expect(
      refusedForWantOfTor([
        source([
          'remote native chain route requires a verified Tor SOCKS proxy',
        ]),
        source(['connection refused']),
      ])
    ).toBe(false);
  });

  it('says nothing when there were no refusals at all', () => {
    expect(refusedForWantOfTor([])).toBe(false);
    expect(refusedForWantOfTor([source([])])).toBe(false);
  });
});
