import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke, isDesktopPlatform } = vi.hoisted(() => ({
  invoke: vi.fn(),
  isDesktopPlatform: vi.fn(() => true),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('../../../utils/platform', () => ({ isDesktopPlatform }));

import { Network } from '../../../state/slices/networkSlice';
import { persistDesktopBackend } from '../networkSettingsBridge';

describe('persistDesktopBackend', () => {
  beforeEach(() => {
    invoke.mockReset();
    isDesktopPlatform.mockReturnValue(true);
  });

  it('replaces the network-scoped Rust selection instead of layering a stale route', async () => {
    await persistDesktopBackend(Network.CHIPNET, {
      kind: 'node',
      target: 'peer.example:48333',
    });

    expect(invoke).toHaveBeenCalledWith('optn_app_dispatch', {
      action: {
        version: 1,
        action: {
          type: 'replace_network_servers',
          value: {
            network: 'chipnet',
            servers: { peer: 'peer.example:48333' },
          },
        },
      },
    });
  });

  it('does nothing outside the desktop shell', async () => {
    isDesktopPlatform.mockReturnValue(false);

    await persistDesktopBackend(Network.MAINNET, { kind: 'auto' });

    expect(invoke).not.toHaveBeenCalled();
  });
});
