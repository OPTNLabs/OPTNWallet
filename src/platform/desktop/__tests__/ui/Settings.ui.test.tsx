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
import Settings from '../../../../features/settings/Settings';
import { translations, type TranslationKey } from '../../../../i18n/resources';

const mock = vi.hoisted(() => ({
  state: { wallet_id: { currentWalletId: 41, networkType: 'chipnet' } },
  invoke: vi.fn(),
  handle: vi.fn(),
}));
vi.mock('react-redux', () => ({
  useDispatch: () => vi.fn(),
  useSelector: (selector: (state: unknown) => unknown) => selector(mock.state),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mock.invoke }));
vi.mock('../../engineWalletBridge', () => ({ engineHandleFor: mock.handle }));
vi.mock('../../../../utils/platform', () => ({
  isDesktopPlatform: () => true,
}));
vi.mock('../../../../platform/capabilities', () => ({
  hasCapability: () => false,
}));
vi.mock('../../../../app/theme/useTheme', () => ({
  useTheme: () => ({ mode: 'dark', toggleMode: vi.fn() }),
}));
vi.mock('../../../../i18n/useI18n', () => ({
  useI18n: () => ({ t: (key: TranslationKey) => translations.en[key] }),
}));

// Keep the settings shell and birthday control real; unrelated destinations
// and wallet services must not start I/O in this navigation fixture.
vi.mock('../../../../apis/WalletManager/WalletManager', () => ({
  default: vi.fn(),
}));
vi.mock('../../../../services/ElectrumAdapter', () => ({ default: vi.fn() }));
vi.mock('../../../../services/RefreshCoordinator', () => ({
  waitForWalletHistoryRefresh: vi.fn(),
}));
vi.mock('../../../../state/slices/wizardconnectSlice', () => ({
  disconnectAllWizardConnections: vi.fn(),
}));
vi.mock('../../../../state/slices/cashconnectSlice', () => ({
  stopCashConnectThunk: vi.fn(),
}));
vi.mock('../../../../features/settings/NetworkSettings', () => ({
  NetworkSettings: () => null,
}));
vi.mock('../../../../features/settings/DerivationPathSettings', () => ({
  DerivationPathSettings: () => null,
}));
vi.mock('../../../../features/settings/ServerSettings', () => ({
  ServerSettings: () => null,
}));
vi.mock('../../../../features/settings/ConsolePanel', () => ({
  ConsolePanel: () => null,
}));
vi.mock('../../../../features/settings/ExperimentalSettings', () => ({
  ExperimentalSettings: () => null,
}));
vi.mock('../../../../features/settings/CashFusionSettings', () => ({
  CashFusionSettings: () => null,
}));
vi.mock('../../../../features/nostr/NostrSettings', () => ({
  NostrSettings: () => null,
}));
vi.mock('../../../../features/settings/AddonsSettings', () => ({
  AddonsSettings: () => null,
}));
vi.mock('../../../../features/settings/AppUpdateSettings', () => ({
  default: () => null,
}));
vi.mock('../../../../features/settings/WalletInfoSettings', () => ({
  WalletInfoSettings: () => null,
}));
vi.mock('../../../../features/settings/LanguageSettings', () => ({
  LanguageSettings: () => null,
}));
vi.mock('../../../../features/settings/AppearanceSettings', () => ({
  AppearanceSettings: () => null,
}));
vi.mock('../../../../features/settings/MerchantPaySettings', () => ({
  MerchantPaySettings: () => null,
}));
vi.mock('../../AppLockSettings', () => ({ AppLockSettings: () => null }));
vi.mock('../../RebuildWalletSettings', () => ({
  RebuildWalletSettings: () => null,
}));
vi.mock('../../ExportColdArchiveSettings', () => ({
  ExportColdArchiveSettings: () => null,
}));
vi.mock('../../../../components/RecoveryPhrase', () => ({
  default: () => null,
}));
vi.mock('../../../../components/AboutView', () => ({ default: () => null }));
vi.mock('../../../../components/TermsOfUse', () => ({ default: () => null }));
vi.mock('../../../../components/ContactUs', () => ({ default: () => null }));
vi.mock('../../../../components/FaucetView', () => ({ default: () => null }));
vi.mock('../../../../components/walletconnect/WalletConnectPanel', () => ({
  default: () => null,
}));
vi.mock('../../../../components/wizardconnect/WizardConnectPanel', () => ({
  default: () => null,
}));
vi.mock('../../../../components/cashconnect/CashConnectPanel', () => ({
  default: () => null,
}));

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  mock.state.wallet_id.currentWalletId = 41;
  mock.handle.mockImplementation(
    async (walletId: number) => `fixture-${walletId}.optn`
  );
  mock.invoke.mockResolvedValue({
    active: 'fixture-41.optn',
    epoch: 7,
    restore_birthday: { kind: 'unknown' },
    manual_rescan_from: null,
  });
});

function settings() {
  return (
    <MemoryRouter initialEntries={['/settings']}>
      <Settings />
    </MemoryRouter>
  );
}

function openBirthday() {
  fireEvent.click(screen.getByRole('button', { name: /Wallet & security/ }));
  fireEvent.click(screen.getByRole('button', { name: /Wallet birthday/ }));
}

it('opens the existing birthday control from Wallet & security and goes back one level', async () => {
  render(settings());
  expect(
    screen.queryByRole('button', { name: /Wallet birthday/ })
  ).not.toBeInTheDocument();
  expect(mock.invoke).not.toHaveBeenCalled();
  openBirthday();
  await screen.findByText('Saved birthday: unknown — full history.');
  expect(
    screen.getByRole('heading', { level: 2, name: 'Wallet birthday' })
  ).toBeInTheDocument();
  expect(mock.handle).toHaveBeenCalledWith(41);
  expect(mock.invoke).toHaveBeenCalledExactlyOnceWith('optn_wallet_security', {
    request: { command: 'status' },
  });

  fireEvent.click(screen.getByRole('button', { name: 'Back', exact: true }));
  expect(
    screen.getByRole('heading', { level: 2, name: 'Wallet & security' })
  ).toBeInTheDocument();
  expect(
    screen.getAllByRole('button', { name: /Wallet birthday/ })
  ).toHaveLength(1);
  expect(
    screen.queryByRole('region', { name: 'Wallet birthday' })
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: /Connections & features/ })
  ).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Back', exact: true }));
  expect(
    screen.getByRole('button', { name: /Wallet & security/ })
  ).toBeInTheDocument();
  expect(
    screen.getByRole('button', { name: /Connections & features/ })
  ).toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: /Wallet birthday/ })
  ).not.toBeInTheDocument();
});

it('remounts birthday for the selected wallet and keeps the existing Rust command', async () => {
  const view = render(settings());
  openBirthday();
  await screen.findByText('Saved birthday: unknown — full history.');
  fireEvent.change(screen.getByLabelText('Wallet history start'), {
    target: { value: 'height' },
  });
  fireEvent.change(screen.getByLabelText('Earliest block'), {
    target: { value: '100' },
  });
  fireEvent.click(
    screen.getByRole('button', { name: 'Review birthday change' })
  );

  mock.state.wallet_id.currentWalletId = 42;
  mock.invoke.mockResolvedValue({
    active: 'fixture-42.optn',
    epoch: 8,
    restore_birthday: { kind: 'imported_at_height', height: 200 },
    manual_rescan_from: null,
  });
  view.rerender(settings());
  await screen.findByText('Saved birthday: block 200.');
  expect(mock.handle).toHaveBeenLastCalledWith(42);
  expect(screen.getByLabelText('Wallet history start')).toHaveValue('unknown');
  expect(screen.queryByLabelText('Earliest block')).not.toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: 'Confirm history start' })
  ).not.toBeInTheDocument();

  fireEvent.click(
    screen.getByRole('button', { name: 'Review birthday change' })
  );
  fireEvent.click(
    screen.getByRole('button', { name: 'Confirm history start' })
  );
  await waitFor(() =>
    expect(mock.invoke).toHaveBeenLastCalledWith('optn_wallet_security', {
      request: {
        command: 'set_birthday',
        epoch: 8,
        birthday: { kind: 'unknown' },
      },
    })
  );
});
