import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

const {
  addChainSource,
  removeChainSource,
  readChainSources,
  setChainPolicy,
  setChainSourceDisposition,
  SELECTABLE_CHAIN_POLICIES,
  CHAIN_POLICY_LABELS,
} = await import('../chainSourcesBridge');

describe('chain sources bridge', () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
  });

  it('asks the runtime for the active network when none is given', async () => {
    invoke.mockResolvedValueOnce({ network: 'chipnet', sources: [] });
    await readChainSources();
    expect(invoke).toHaveBeenCalledWith('optn_chain_sources', {
      network: null,
    });
  });

  it('never offers custom as a policy to select', () => {
    // `custom` is what the runtime answers when a saved policy has no name.
    // Sending it back would ask the host to overwrite that policy with a guess,
    // which is how "own infrastructure only" would quietly become public Auto.
    expect(SELECTABLE_CHAIN_POLICIES).not.toContain('custom');
    expect(CHAIN_POLICY_LABELS.custom).toMatch(/custom/i);
  });

  it('passes each edit through to the host unchanged', async () => {
    await setChainPolicy('own_infrastructure');
    expect(invoke).toHaveBeenCalledWith('optn_chain_set_policy', {
      policy: 'own_infrastructure',
      network: null,
    });

    await setChainSourceDisposition('host:node.example', 'banned');
    expect(invoke).toHaveBeenCalledWith('optn_chain_set_source_disposition', {
      source: 'host:node.example',
      disposition: 'banned',
      network: null,
    });

    await removeChainSource('host:node.example', 'chipnet');
    expect(invoke).toHaveBeenCalledWith('optn_chain_remove_source', {
      source: 'host:node.example',
      network: 'chipnet',
    });
  });

  it('sends own-infrastructure as a declared group, not as a guess about the address', async () => {
    // Ownership is a claim only the holder can make: it decides what
    // `own_infrastructure` policy selects and what may be dialled directly
    // instead of through Tor, so it must never be inferred from a private IP.
    await addChainSource({
      label: 'Rack',
      kind: 'p2p',
      host: '10.0.0.2',
      port: 8333,
      infrastructureGroup: 'mine',
    });
    expect(invoke).toHaveBeenCalledWith('optn_chain_add_source', {
      request: {
        label: 'Rack',
        kind: 'p2p',
        host: '10.0.0.2',
        port: 8333,
        infrastructure_group: 'mine',
        network: null,
      },
    });

    await addChainSource({
      label: '',
      kind: 'electrum-tls',
      host: 'a.example',
    });
    expect(invoke).toHaveBeenLastCalledWith('optn_chain_add_source', {
      request: {
        label: '',
        kind: 'electrum-tls',
        host: 'a.example',
        port: null,
        infrastructure_group: null,
        network: null,
      },
    });
  });
});
