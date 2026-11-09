import { beforeEach, describe, expect, it, vi } from 'vitest';

// Rust answers `optn_chain_electrum_pool`; the module caches per network until
// Rust says the network's settings changed.
const invokeMock = vi.fn();
let poolChanged: ((event: { payload: string }) => void) | null = null;

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(
    async (_name: string, handler: (event: { payload: string }) => void) => {
      poolChanged = handler;
      return () => undefined;
    }
  ),
}));

const mainnet = {
  allowed: true,
  reason: null,
  servers: [
    { host: 'bch.imaginary.cash', port: 50002, tls: true },
    { host: 'node.lan', port: 50001, tls: false },
    { host: '2001:db8::1', port: 50002, tls: true },
    { host: 'fulcrum.example.onion', port: 50002, tls: true },
  ],
};

type Hook = (network: string) => string[] | null;
const hook = () =>
  (globalThis as { __OPTN_ELECTRUM_POOL__?: Hook }).__OPTN_ELECTRUM_POOL__!;

describe('desktop Electrum pool', () => {
  beforeEach(() => {
    vi.resetModules();
    invokeMock.mockReset();
    poolChanged = null;
  });

  it('is fetched once per network and written as the client entries', async () => {
    invokeMock.mockResolvedValue(mainnet);
    const { electrumPool, poolEntries } = await import('../electrumPool');
    const [first, second] = await Promise.all([
      electrumPool('mainnet'),
      electrumPool('mainnet'),
    ]);
    expect(first).toBe(second);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith('optn_chain_electrum_pool', {
      network: 'mainnet',
    });
    // Plain TCP and IPv6 literals cannot be written as `host:port` TLS entries.
    expect(poolEntries(first)).toEqual([
      'bch.imaginary.cash:50002',
      'fulcrum.example.onion:50002',
    ]);
  });

  it('feeds the shared server list only once Rust has answered', async () => {
    invokeMock.mockResolvedValue(mainnet);
    const { electrumPool } = await import('../electrumPool');
    expect(hook()('mainnet')).toBeNull();
    await electrumPool('mainnet');
    expect(hook()('mainnet')).toEqual([
      'bch.imaginary.cash:50002',
      'fulcrum.example.onion:50002',
    ]);
  });

  it('asks again after the network settings change', async () => {
    invokeMock.mockResolvedValueOnce(mainnet).mockResolvedValueOnce({
      allowed: false,
      reason: 'Privacy does not use Electrum servers.',
      servers: [],
    });
    const { electrumPool } = await import('../electrumPool');
    await electrumPool('mainnet');
    await vi.waitFor(() => expect(poolChanged).not.toBeNull());
    poolChanged!({ payload: 'chipnet' });
    await electrumPool('mainnet');
    expect(invokeMock).toHaveBeenCalledTimes(1);
    poolChanged!({ payload: 'mainnet' });
    const after = await electrumPool('mainnet');
    expect(after.allowed).toBe(false);
    expect(hook()('mainnet')).toEqual([]);
  });

  it('does not remember a failure', async () => {
    invokeMock
      .mockRejectedValueOnce('network settings reader stopped')
      .mockResolvedValueOnce(mainnet);
    const { electrumPool } = await import('../electrumPool');
    await expect(electrumPool('mainnet')).rejects.toBe(
      'network settings reader stopped'
    );
    await expect(electrumPool('mainnet')).resolves.toEqual(mainnet);
  });

  it('tells a policy refusal from a failing server', async () => {
    const { isNotSelected, notSelectedError } = await import('../electrumPool');
    expect(isNotSelected(notSelectedError('Privacy'))).toBe(true);
    expect(
      isNotSelected(
        'electrum-not-selected: bch.example:50002 is not one of the servers selected for mainnet.'
      )
    ).toBe(true);
    expect(
      isNotSelected(new Error('connect bch.example:50002 timed out'))
    ).toBe(false);
  });
});
