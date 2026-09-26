/** @vitest-environment jsdom */
import React from 'react';
import '@testing-library/jest-dom/vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ChainSourcesView } from '../../chainSourcesBridge';
import { ChainSourcesSettings } from '../../../../features/settings/ChainSourcesSettings';

const mock = vi.hoisted(() => ({ invoke: vi.fn(), dispatch: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mock.invoke }));
vi.mock('react-redux', () => ({ useDispatch: () => mock.dispatch }));
vi.mock('../../engineWalletBridge', () => ({
  readEngineWalletSync: async () => null,
  refreshEngineWallet: vi.fn(),
}));
vi.mock('../../FusionStatusService', () => ({
  integratedTorStatus: vi.fn(),
  startIntegratedTor: vi.fn(),
}));
vi.mock('../../../../state/slices/preferencesSlice', () => ({
  setChainPolicy: (policy: string) => ({ type: 'policy', policy }),
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('browses without probes and sends explicit selection through the old UI', async () => {
  const polling = vi.spyOn(globalThis, 'setInterval');
  const endpoint = { kind: 'p2p', host: 'public.example', port: 48333 };
  const view: ChainSourcesView = {
    unavailable_services: [
      {
        id: 'token-indexer',
        label: 'Token indexer',
        reason: 'Provider adapter unavailable',
      },
      {
        id: 'metadata-proxy',
        label: 'Metadata proxy / cache',
        reason: 'Provider adapter unavailable',
      },
    ],
    network: 'chipnet',
    policy: 'auto',
    protocols: ['bip37'],
    scope: 'all',
    configuration_error: null,
    wallet_routes: 0,
    verified_tip: null,
    tor: { status: 'absent', socks_port: null, trusted_ports: [] },
    selection: {
      protocols: ['Bip37'],
      primary_scope: { Selected: ['public'] },
      fallback_scope: null,
      preferred: [],
    },
    sources: [
      {
        id: 'public',
        label: 'Public source',
        origin: 'bootstrap',
        group: null,
        disposition: 'enabled',
        priority: 0,
        can_remove: false,
        endpoints: [endpoint],
        capabilities: [],
        role: 'primary',
        live_protocols: [],
        failures: [],
        protocol_statuses: [
          { endpoint, protocol: 'bip37', status: 'advertised' },
          { endpoint, protocol: 'neutrino', status: 'unknown' },
        ],
      },
    ],
  };
  mock.invoke.mockReset();
  mock.invoke.mockImplementation(async (command: string) =>
    command === 'optn_chain_sources' ? view : undefined
  );
  const backRef = { current: null as (() => void) | null };
  render(
    <ChainSourcesSettings
      backRef={backRef}
      birthdaySettings={<button>Existing birthday control</button>}
      fusionSettings={<button>Automatic Fusion server selection</button>}
      nostrSettings={<button>Existing Nostr relay pool</button>}
      feeSettings={<button>Existing fee control</button>}
      explorerSettings={<button>Existing explorer control</button>}
    />
  );
  await screen.findByTestId('chain-sources-public');
  fireEvent.click(screen.getByRole('button', { name: /Metadata & indexing/ }));
  expect(
    screen.getByRole('button', { name: /Token indexer.*unavailable/ })
  ).toBeDisabled();
  expect(screen.getByText('IPFS gateways')).toBeInTheDocument();
  expect(
    screen.getByRole('button', { name: 'Token indexer — unavailable' })
  ).toBeDisabled();
  expect(screen.queryByText(/able to sync right now/)).not.toBeInTheDocument();
  expect(
    mock.invoke.mock.calls.every(
      ([command]) => command === 'optn_chain_sources'
    )
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Add BCMR indexer' }));
  fireEvent.change(screen.getByLabelText('Host or IP address'), {
    target: { value: 'bcmr.example' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  expect(
    screen.getByRole('checkbox', {
      name: 'BCMR indexer (Paytaca-compatible HTTPS)',
    })
  ).toBeChecked();
  fireEvent.click(screen.getByRole('button', { name: 'Save source' }));
  await waitFor(() =>
    expect(mock.invoke).toHaveBeenCalledWith('optn_chain_add_source', {
      request: {
        label: 'bcmr.example',
        host: 'bcmr.example',
        kind: 'bcmr-indexer',
        port: 443,
        network: 'chipnet',
        infrastructure_group: null,
        services: [],
      },
    })
  );
  await screen.findByRole('button', { name: 'Add a source' });
  mock.invoke.mockClear(); // Subsequent directory navigation must remain read-only.
  act(() => backRef.current?.());
  expect(screen.getByText('BCMR indexers')).toBeInTheDocument();
  act(() => backRef.current?.());
  expect(backRef.current).toBeNull();
  expect(
    within(
      screen.getByRole('navigation', { name: 'Network source settings' })
    ).getAllByRole('button')[0]
  ).toHaveTextContent('Routing');
  expect(
    screen.queryByRole('button', { name: /^Wallet sync/ })
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole('button', { name: /Diagnostics/ })
  ).toBeInTheDocument();
  fireEvent.click(screen.getByTestId('chain-sources-public'));
  fireEvent.change(screen.getByLabelText('Service filter'), {
    target: { value: 'neutrino' },
  });
  expect(screen.queryByTestId('chain-source-public')).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Service filter'), {
    target: { value: 'bip37' },
  });
  fireEvent.click(
    within(screen.getByTestId('chain-source-public')).getByRole('button', {
      name: 'View details',
    })
  );
  expect(
    screen.queryByRole('button', { name: 'Remove this user source' })
  ).not.toBeInTheDocument();
  expect(
    mock.invoke.mock.calls.every(
      ([command]) => command === 'optn_chain_sources'
    )
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Configure routing' }));
  expect(
    within(
      screen.getByRole('group', { name: 'Allowed chain access' })
    ).queryByLabelText(/notifications/i)
  ).not.toBeInTheDocument();
  expect(
    within(screen.getByRole('group', { name: 'Event sources' })).getByRole(
      'checkbox'
    )
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Prefer first' }));
  fireEvent.click(screen.getByRole('button', { name: 'Remove preference' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save selection' }));
  await waitFor(() =>
    expect(mock.invoke).toHaveBeenCalledWith('optn_chain_set_selection', {
      network: 'chipnet',
      selection: view.selection,
    })
  );
  expect(
    screen.queryByRole('button', { name: 'Back' })
  ).not.toBeInTheDocument();
  act(() => backRef.current?.());
  expect(
    screen.getByRole('button', { name: 'Configure routing' })
  ).toBeInTheDocument();
  act(() => backRef.current?.());
  expect(screen.getByTestId('chain-source-public')).toBeInTheDocument();
  act(() => backRef.current?.());
  expect(backRef.current).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /Explorer/ }));
  expect(
    screen.getByRole('button', { name: 'Existing explorer control' })
  ).toBeInTheDocument();
  act(() => backRef.current?.());
  fireEvent.click(screen.getByRole('button', { name: 'Transaction fees' }));
  expect(
    screen.getByRole('button', { name: 'Existing fee control' })
  ).toBeInTheDocument();
  act(() => backRef.current?.());
  expect(backRef.current).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /CashFusion/ }));
  expect(
    screen.getByRole('button', { name: 'Automatic Fusion server selection' })
  ).toBeInTheDocument();
  act(() => backRef.current?.());
  expect(backRef.current).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Nostr' }));
  expect(
    screen.getByRole('button', { name: 'Existing Nostr relay pool' })
  ).toBeInTheDocument();
  expect(screen.queryByText(/able to sync right now/)).not.toBeInTheDocument();
  act(() => backRef.current?.());
  expect(backRef.current).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /Wallet birthday/ }));
  expect(
    screen.getByRole('button', { name: 'Existing birthday control' })
  ).toBeInTheDocument();
  act(() => backRef.current?.());
  expect(backRef.current).toBeNull();
  fireEvent.click(screen.getByTestId('chain-sources-own'));
  fireEvent.click(screen.getByRole('button', { name: 'Add infrastructure' }));
  fireEvent.change(screen.getByLabelText('Name'), {
    target: { value: 'Home node' },
  });
  fireEvent.change(screen.getByLabelText('Host or IP address'), {
    target: { value: 'node.home' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  for (const service of view.unavailable_services ?? []) {
    const entry = screen.getByRole('checkbox', { name: service.label });
    expect(entry).toBeDisabled();
    expect(entry).not.toBeChecked();
    expect(entry).toHaveAccessibleDescription(service.reason);
  }
  for (const [label, port] of [
    ['BCH peer (BIP37 / Neutrino)', '48333'],
    ['Node RPC', '48332'],
    ['Node ZMQ', '28332'],
    ['IPFS gateway (HTTPS)', '443'],
  ]) {
    fireEvent.click(screen.getByRole('checkbox', { name: label }));
    fireEvent.change(screen.getByLabelText(`${label} port`), {
      target: { value: port },
    });
  }
  mock.invoke.mockImplementation(
    async (
      command: string,
      args?: { request: { services: { kind: string; port: number }[] } }
    ) => {
      if (
        command === 'optn_chain_add_source' &&
        !view.sources.some((source) => source.id === 'host:node.home')
      ) {
        view.sources.push({
          ...view.sources[0],
          id: 'host:node.home',
          label: 'Home node',
          origin: 'own-infrastructure',
          group: 'mine',
          can_remove: true,
          endpoints: [
            { kind: 'p2p', host: 'node.home', port: 48333 },
            ...(args?.request.services ?? []).map((service) => ({
              ...service,
              host: 'node.home',
            })),
          ],
        });
      }
      return command === 'optn_chain_sources' ? view : undefined;
    }
  );
  fireEvent.click(screen.getByRole('button', { name: 'Save source' }));
  await waitFor(() =>
    expect(mock.invoke).toHaveBeenCalledWith('optn_chain_add_source', {
      request: {
        label: 'Home node',
        host: 'node.home',
        kind: 'p2p',
        port: 48333,
        network: 'chipnet',
        infrastructure_group: 'mine',
        services: [
          { kind: 'node-rpc', port: 48332 },
          { kind: 'node-zmq', port: 28332 },
          { kind: 'ipfs-gateway', port: 443 },
        ],
      },
    })
  );
  const card = await screen.findByTestId('chain-source-host:node.home');
  fireEvent.click(within(card).getByRole('button', { name: 'View details' }));
  fireEvent.click(screen.getByRole('button', { name: 'Add services' }));
  expect(screen.getByRole('checkbox', { name: 'Node RPC' })).toBeDisabled();
  expect(screen.queryByLabelText('Host or IP address')).not.toBeInTheDocument();
  fireEvent.click(
    screen.getByRole('checkbox', { name: 'Electrum / Fulcrum (TLS)' })
  );
  fireEvent.change(screen.getByLabelText('Electrum / Fulcrum (TLS) port'), {
    target: { value: '50002' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save services' }));
  await waitFor(() =>
    expect(mock.invoke).toHaveBeenLastCalledWith('optn_chain_sources', {
      network: null,
    })
  );
  expect(mock.invoke).toHaveBeenCalledWith('optn_chain_add_source', {
    request: {
      label: 'Home node',
      host: 'node.home',
      kind: 'electrum-tls',
      port: 50002,
      services: [],
      network: 'chipnet',
      infrastructure_group: 'mine',
    },
  });
  fireEvent.click(await screen.findByRole('button', { name: 'Add services' }));
  fireEvent.click(
    screen.getByRole('checkbox', { name: 'Electrum / Fulcrum (TLS)' })
  );
  mock.invoke.mockImplementation(async (command: string) => {
    if (command === 'optn_chain_add_source')
      throw new Error('Source could not be saved');
    return command === 'optn_chain_sources' ? view : undefined;
  });
  fireEvent.change(screen.getByLabelText('Electrum / Fulcrum (TLS) port'), {
    target: { value: '50002' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save services' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Source could not be saved'
  );
  const refreshPoll = polling.mock.calls.find(
    ([, delay]) => delay === 4000
  )?.[0];
  expect(typeof refreshPoll).toBe('function');
  await act(async () => {
    (refreshPoll as () => void)();
  });
  expect(screen.getByRole('alert')).toHaveTextContent(
    'Source could not be saved'
  );
  cleanup();
  render(
    <ChainSourcesSettings
      initialPage="nostr"
      backRef={backRef}
      nostrSettings={<button>Complete Nostr settings</button>}
    />
  );
  await screen.findByRole('button', { name: 'Complete Nostr settings' });
  act(() => backRef.current?.());
  expect(
    screen.getByRole('navigation', { name: 'Network source settings' })
  ).toBeInTheDocument();
});
