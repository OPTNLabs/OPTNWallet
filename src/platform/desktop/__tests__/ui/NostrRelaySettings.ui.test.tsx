// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NostrSettings } from '../../../../features/nostr/NostrSettings';
import experimental, {
  selectNostrRelays,
} from '../../../../state/slices/experimentalSlice';
import preferences from '../../../../state/slices/preferencesSlice';
import networkReducer, {
  Network,
  setNetwork,
} from '../../../../state/slices/networkSlice';
import { I18nProvider } from '../../../../i18n/I18nProvider';
import type { RootState } from '../../../../state/store';

const network = vi.hoisted(() => ({
  probe: vi.fn(),
  identity: vi.fn(),
  profile: vi.fn(),
  name: vi.fn(),
  publishName: vi.fn(),
  publishProfile: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: network.probe }));
vi.mock('../../../../utils/platform', () => ({
  isDesktopPlatform: () => true,
}));
vi.mock('../../nostr/chat', () => ({
  myIdentity: network.identity,
  fetchProfile: network.profile,
  fetchPublishedDisplayName: network.name,
  publishDisplayName: network.publishName,
  publishMyProfile: network.publishProfile,
}));
vi.mock('../../nostr/mls', () => ({
  claimExtraMlsDeviceSlot: vi.fn(),
  loadMlsDeviceIndex: vi.fn().mockResolvedValue(0),
  publishMlsKeyPackage: vi.fn(),
}));
vi.mock('../../../../components/WalletConfirmDialog', () => ({
  useWalletConfirm: () => vi.fn(),
}));

function showSettings(walletId = 1) {
  const store = configureStore({
    reducer: {
      experimental,
      preferences,
      network: networkReducer,
      wallet_id: () => ({ currentWalletId: walletId }),
    },
  });
  store.dispatch(setNetwork(Network.CHIPNET));
  render(
    <Provider store={store}>
      <I18nProvider>
        <NostrSettings />
      </I18nProvider>
    </Provider>
  );
  return store;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
beforeEach(() => {
  vi.clearAllMocks();
  network.identity.mockResolvedValue({
    npub: 'npub-test',
    pubkey: 'public-test-key',
  });
  network.profile.mockResolvedValue({ name: 'Saved name' });
  network.name.mockResolvedValue('');
  network.probe.mockImplementation(
    async (_command: string, { relays }: { relays: string[] }) => ({
      relays: relays.map((url) => ({ url, reachable: true })),
    })
  );
});

it('automatically checks native reachability, supports relay edits and an explicit recheck', async () => {
  const store = showSettings();
  await screen.findByText(/reachable at last check/);
  expect(network.probe).toHaveBeenCalledWith('nostr_relay_health', {
    relays: selectNostrRelays(store.getState() as RootState),
    network: 'chipnet',
    force: false,
  });
  expect(
    screen.queryByRole('button', { name: /(?:Enable|Disable) Nostr chat/i })
  ).not.toBeInTheDocument();
  expect(network.profile).not.toHaveBeenCalled();
  expect(network.publishProfile).not.toHaveBeenCalled();
  expect(network.publishName).not.toHaveBeenCalled();

  const relay = 'wss://relay.user.example';
  fireEvent.change(screen.getByLabelText('Relay URL'), {
    target: { value: relay },
  });
  fireEvent.keyDown(screen.getByLabelText('Relay URL'), { key: 'Enter' });
  expect(selectNostrRelays(store.getState() as RootState)).toContain(relay);
  await waitFor(() =>
    expect(network.probe).toHaveBeenLastCalledWith('nostr_relay_health', {
      relays: expect.arrayContaining([relay]),
      network: 'chipnet',
      force: false,
    })
  );
  fireEvent.click(screen.getByRole('button', { name: 'Remove ' + relay }));
  expect(selectNostrRelays(store.getState() as RootState)).not.toContain(relay);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /Check relay/i })).toBeEnabled()
  );
  fireEvent.click(screen.getByRole('button', { name: /Check relay/i }));
  await waitFor(() =>
    expect(network.probe).toHaveBeenLastCalledWith('nostr_relay_health', {
      relays: selectNostrRelays(store.getState() as RootState),
      network: 'chipnet',
      force: true,
    })
  );
});

it('keeps profile loading and publishing explicit despite automatic health checks', async () => {
  const store = showSettings();
  await screen.findByText('npub-test');
  expect(network.profile).not.toHaveBeenCalled();
  expect(network.name).not.toHaveBeenCalled();
  expect(network.publishProfile).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole('button', { name: 'Load published profile' })
  );
  await screen.findByDisplayValue('Saved name');
  fireEvent.change(screen.getByLabelText('Display name'), {
    target: { value: 'New name' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Publish profile' }));
  await waitFor(() =>
    expect(network.publishProfile).toHaveBeenCalledWith(
      1,
      { name: 'New name' },
      selectNostrRelays(store.getState() as RootState)
    )
  );
  expect(network.publishName).toHaveBeenCalledWith(
    1,
    'New name',
    selectNostrRelays(store.getState() as RootState)
  );
});

it('ignores an old network reply and keeps policy-blocked relays distinct from unreachable ones', async () => {
  let resolveOld!: (reply: unknown) => void;
  network.probe.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOld = resolve;
      })
  );
  const store = showSettings();
  const relays = selectNostrRelays(store.getState() as RootState);
  network.probe.mockResolvedValueOnce({
    relays: relays.map((url) => ({
      url,
      reachable: null,
      reason: 'Blocked by source policy',
    })),
    error: 'Blocked by source policy',
  });
  act(() => {
    store.dispatch(setNetwork(Network.MAINNET));
  });
  await screen.findByText('Blocked by source policy');
  await act(async () => {
    resolveOld({ relays: relays.map((url) => ({ url, reachable: true })) });
  });
  expect(screen.queryByText('Reachable')).not.toBeInTheDocument();
  expect(screen.queryByText('Unreachable')).not.toBeInTheDocument();
  expect(screen.getAllByText('Not checked')).toHaveLength(relays.length);
  expect(network.probe).toHaveBeenLastCalledWith('nostr_relay_health', {
    relays,
    network: 'mainnet',
    force: false,
  });
});

it('does not check relays or derive identity before a wallet opens', () => {
  showSettings(0);
  expect(network.probe).not.toHaveBeenCalled();
  expect(network.identity).not.toHaveBeenCalled();
});

it('rechecks automatically and stops its timer when the view is unmounted', async () => {
  vi.useFakeTimers();
  showSettings();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
  });
  expect(network.probe).toHaveBeenCalledTimes(2);
  expect(network.probe).toHaveBeenLastCalledWith(
    'nostr_relay_health',
    expect.objectContaining({ force: false })
  );
  cleanup();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(network.probe).toHaveBeenCalledTimes(2);
  expect(network.publishProfile).not.toHaveBeenCalled();
});
