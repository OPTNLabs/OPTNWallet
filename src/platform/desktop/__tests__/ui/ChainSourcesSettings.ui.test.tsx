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
afterEach(cleanup);

it('browses without probes and sends explicit selection through the old UI', async () => {
  const endpoint = { kind: 'p2p', host: 'public.example', port: 48333 };
  const view: ChainSourcesView = {
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
      fusionSettings={<button>Automatic Fusion server selection</button>}
      feeSettings={<button>Existing fee control</button>}
      explorerSettings={<button>Existing explorer control</button>}
    />
  );
  fireEvent.click(await screen.findByTestId('chain-sources-public'));
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
});
