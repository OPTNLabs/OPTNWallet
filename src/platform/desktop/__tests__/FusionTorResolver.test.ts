import { describe, expect, it, vi } from 'vitest';

import {
  resolveFusionTransport,
  type FusionTorProbes,
} from '../FusionTorResolver';

function probes(overrides: Partial<FusionTorProbes> = {}): FusionTorProbes {
  return {
    integratedStatus: vi.fn(async () => ({
      running: false,
      bootstrap_percent: 0,
      socks_port: 0,
    })),
    detectPort: vi.fn(async () => null),
    checkPort: vi.fn(async () => false),
    ...overrides,
  };
}

const base = {
  enabled: true,
  auto: true,
  host: '127.0.0.1',
  manualPort: 9050,
};

describe('Fusion Tor resolver', () => {
  it('allows direct transport only for a local destination', async () => {
    await expect(
      resolveFusionTransport('localhost', base, probes())
    ).resolves.toEqual({ type: 'direct' });
    await expect(
      resolveFusionTransport(
        'fusion.example',
        { ...base, enabled: false },
        probes()
      )
    ).resolves.toMatchObject({ type: 'unavailable' });
  });

  it('prefers the fully bootstrapped integrated Tor process', async () => {
    const detected = vi.fn(async () => 9050);
    const route = await resolveFusionTransport(
      'fusion.example',
      base,
      probes({
        integratedStatus: vi.fn(async () => ({
          running: true,
          bootstrap_percent: 100,
          socks_port: 17655,
        })),
        detectPort: detected,
      })
    );

    expect(route).toEqual({
      type: 'tor',
      tor: { host: '127.0.0.1', port: 17655 },
    });
    expect(detected).not.toHaveBeenCalled();
  });

  it('falls back to Electron Cash-style external Tor auto-detection', async () => {
    const route = await resolveFusionTransport(
      'fusion.example',
      base,
      probes({ detectPort: vi.fn(async () => 9150) })
    );

    expect(route).toEqual({
      type: 'tor',
      tor: { host: '127.0.0.1', port: 9150 },
    });
  });

  it('verifies a manually configured proxy is really Tor', async () => {
    const route = await resolveFusionTransport(
      'fusion.example',
      { ...base, auto: false, manualPort: 19050 },
      probes({ checkPort: vi.fn(async () => true) })
    );

    expect(route).toEqual({
      type: 'tor',
      tor: { host: '127.0.0.1', port: 19050 },
    });
  });
});
