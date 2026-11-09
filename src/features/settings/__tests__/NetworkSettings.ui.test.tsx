/** @vitest-environment jsdom */
import React from 'react';
import '@testing-library/jest-dom/vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NetworkSettings } from '../NetworkSettings';
import { Network } from '../../../state/slices/networkSlice';

const mock = vi.hoisted(() => ({
  state: {
    wallet_id: {
      currentWalletId: 41,
      networkType: 'chipnet',
      derivationPath: '',
      derivationPathSource: 'default',
    },
  },
  reload: vi.fn(),
  reconfigure: vi.fn(),
}));

vi.mock('react-redux', () => ({
  useSelector: (selector: (state: unknown) => unknown) => selector(mock.state),
}));

vi.mock('../../../services/WalletReconfigurationService', () => ({
  getDefaultPathForNetwork: () => "m/44'/145'/0'",
  reloadActiveWallet: mock.reload,
  reconfigureActiveWallet: mock.reconfigure,
}));

vi.mock('../../../i18n/useI18n', () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, string | number>) => {
      const copy: Record<string, string> = {
        'settingsNetwork.mainnet': 'Mainnet',
        'settingsNetwork.chipnet': 'Chipnet',
        'settingsNetwork.mainnetDescription': 'Live BCH network — real funds',
        'settingsNetwork.chipnetDescription': 'Test funds only',
        'settingsNetwork.description': 'Network description',
        'settingsNetwork.reload': 'Reload and resync current wallet',
        'settingsNetwork.reloading': 'Reloading wallet…',
        'settingsNetwork.active': 'Active',
        'settingsNetwork.switching': 'Switching…',
        'settingsNetwork.switchToMainnet': 'Switch to Mainnet',
        'settingsNetwork.switchToChipnet': 'Switch to Chipnet',
        'settingsNetwork.switchPrompt':
          'You are about to change the active network to {network}.',
        'settingsNetwork.mainnetWarning':
          'Mainnet uses real BCH and real value.',
        'settingsNetwork.chipnetWarning': 'Chipnet is for test funds only.',
        'settingsNetwork.switchDetails':
          'The wallet will clear the current network records and resynchronize addresses.',
        'settingsNetwork.errorTitle': 'Network update could not be completed',
        'settingsNetwork.switchFailed':
          'The network was not changed. Check your connection and try again.',
        'settingsNetwork.reloadCompleted': 'Wallet reloaded successfully.',
        'settingsNetwork.reloadFailed':
          'The wallet could not be reloaded. Check your connection and try again.',
        'settingsNetwork.retry': 'Try again',
        'settingsNetwork.comingSoon': 'Coming soon',
        'settingsNetwork.testnet3': 'Testnet3',
        'settingsNetwork.testnet4': 'Testnet4',
        'settingsNetwork.regtest': 'Regtest',
        'confirm.cancel': 'Cancel',
      };
      let message = copy[key] ?? key;
      for (const [name, value] of Object.entries(values ?? {})) {
        message = message.replace(`{${name}}`, String(value));
      }
      return message;
    },
  }),
}));

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  mock.state.wallet_id.currentWalletId = 41;
  mock.state.wallet_id.networkType = Network.CHIPNET;
  mock.state.wallet_id.derivationPath = '';
  mock.state.wallet_id.derivationPathSource = 'default';
  mock.reload.mockResolvedValue(undefined);
  mock.reconfigure.mockResolvedValue(undefined);
});

function renderSettings() {
  return render(
    <MemoryRouter initialEntries={['/settings/network']}>
      <NetworkSettings />
    </MemoryRouter>
  );
}

it('requires confirmation before changing the active network', async () => {
  renderSettings();

  fireEvent.click(screen.getByRole('button', { name: /Mainnet/ }));

  expect(
    screen.getByRole('heading', { name: 'Switch to Mainnet' })
  ).toBeInTheDocument();
  expect(screen.getByText(/real BCH and real value/)).toBeInTheDocument();
  expect(mock.reconfigure).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(
    screen.queryByRole('heading', { name: 'Switch to Mainnet' })
  ).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: /Mainnet/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Switch to Mainnet' }));

  await waitFor(() => expect(mock.reconfigure).toHaveBeenCalledOnce());
  expect(mock.reconfigure).toHaveBeenCalledWith({
    walletId: 41,
    network: Network.MAINNET,
    derivationPath: "m/44'/145'/0'",
    derivationPathSource: 'default',
    operation: 'network-switch',
  });
});

it('shows a recoverable error when a network switch fails', async () => {
  mock.reconfigure.mockRejectedValueOnce(new Error('transport failure'));
  renderSettings();

  fireEvent.click(screen.getByRole('button', { name: /Mainnet/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Switch to Mainnet' }));

  expect(await screen.findByRole('alert')).toHaveTextContent(
    'The network was not changed'
  );
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(
    screen.getByRole('heading', { name: 'Switch to Mainnet' })
  ).toBeInTheDocument();
  expect(mock.reload).not.toHaveBeenCalled();
});

it('reports a successful wallet reload', async () => {
  renderSettings();

  fireEvent.click(
    screen.getByRole('button', { name: 'Reload and resync current wallet' })
  );

  expect(await screen.findByRole('status')).toHaveTextContent(
    'Wallet reloaded successfully.'
  );
  expect(mock.reload).toHaveBeenCalledOnce();
});
