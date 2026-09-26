/** @vitest-environment jsdom */
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ServerSettings } from '../ServerSettings';

const mock = vi.hoisted(() => ({ desktop: true, adapter: vi.fn() }));
vi.mock('../../../utils/platform', () => ({
  isDesktopPlatform: () => mock.desktop,
}));
vi.mock('../../../i18n/useI18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock('react-redux', () => ({
  useDispatch: () => vi.fn(),
  useSelector: (selector: (state: unknown) => unknown) => selector({}),
}));
vi.mock('../../../state/selectors/networkSelectors', () => ({
  selectCurrentNetwork: () => 'chipnet',
}));
vi.mock('../../../state/slices/preferencesSlice', () => ({
  selectExplorerId: () => 'custom',
  selectExplorerCustom: () => ({ tx: '', address: '' }),
  selectFeeMode: () => 'auto',
  selectCustomFeeSatPerByte: () => 1,
  setExplorerId: vi.fn(),
  setExplorerCustom: vi.fn(),
  setFeeMode: vi.fn(),
  setCustomFeeSatPerByte: vi.fn(),
}));
vi.mock('../../../services/ElectrumAdapter', () => ({ default: mock.adapter }));
vi.mock('../../../utils/servers/ElectrumServers', () => ({
  getElectrumServers: () => [],
}));
vi.mock('../../../utils/servers/userServers', () => ({
  getUserServers: () => [],
  addUserServer: vi.fn(),
  removeUserServer: vi.fn(),
  isValidServerEntry: vi.fn(),
  getServerLabel: vi.fn(),
  parseServerEntry: vi.fn(),
}));
vi.mock('../../../utils/servers/userNodes', () => ({
  getUserNodes: () => [],
  addUserNode: vi.fn(),
  removeUserNode: vi.fn(),
}));
vi.mock('../../../platform/desktop/backendSelection', () => ({
  getBackend: () => ({ kind: 'auto' }),
  setBackend: vi.fn(),
  BACKEND_CHANGED_EVENT: 'backend-changed',
}));
vi.mock('../../../platform/desktop/networkSettingsBridge', () => ({
  persistDesktopBackend: vi.fn(),
}));
vi.mock('../Bip37NodeSettings', () => ({ Bip37NodeRow: () => null }));
vi.mock('../../../state/slices/walletSlice', () => ({
  selectWalletId: () => 1,
}));
vi.mock('../WalletBirthdaySettings', () => ({
  WalletBirthdaySettings: () => <div>Birthday</div>,
}));
vi.mock('../CashFusionSettings', () => ({
  CashFusionSettings: ({ variant }: { variant: string }) => (
    <div>CashFusion {variant}</div>
  ),
}));
vi.mock('../../nostr/NostrSettings', () => ({
  NostrSettings: () => <div>Complete Nostr settings</div>,
}));
vi.mock('../ChainSourcesSettings', () => ({
  ChainSourcesSettings: ({
    feeSettings,
    fusionSettings,
    nostrSettings,
  }: {
    feeSettings: React.ReactNode;
    fusionSettings: React.ReactNode;
    nostrSettings: React.ReactNode;
  }) => (
    <div>
      Sources destination{feeSettings}
      {fusionSettings}
      {nostrSettings}
    </div>
  ),
}));
afterEach(cleanup);

it('uses one desktop routing destination, retaining fees and the mobile controls', () => {
  const backRef = { current: null as (() => void) | null };
  render(<ServerSettings backRef={backRef} />);
  expect(screen.queryByText('server.manual')).not.toBeInTheDocument();
  expect(screen.queryByText('server.backend')).not.toBeInTheDocument();
  expect(screen.queryByText('server.connect')).not.toBeInTheDocument();
  expect(screen.getByText('server.transactionFee')).toBeInTheDocument();
  expect(mock.adapter).not.toHaveBeenCalled();
  expect(screen.getByText('CashFusion servers')).toBeInTheDocument();
  expect(screen.getByText('Complete Nostr settings')).toBeInTheDocument();
  expect(screen.getByText('Sources destination')).toBeInTheDocument();
  cleanup();
  mock.desktop = false;
  mock.adapter.mockReturnValue({ getCurrentServer: () => null });
  render(<ServerSettings />);
  expect(screen.getByText('server.manual')).toBeInTheDocument();
  expect(screen.getByText('server.connect')).toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: /Network sources/ })
  ).not.toBeInTheDocument();
});
