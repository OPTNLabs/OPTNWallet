import React from 'react';
import '@testing-library/jest-dom/vitest';
import {
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
  setNostrChatEnabled,
  selectNostrRelays,
} from '../../../../state/slices/experimentalSlice';
import preferences from '../../../../state/slices/preferencesSlice';
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
vi.mock('../../nostr/chat', () => ({
  checkRelayStatus: network.probe,
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
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  network.identity.mockResolvedValue({
    npub: 'npub-test',
    pubkey: 'public-test-key',
  });
  network.profile.mockResolvedValue({ name: 'Saved name' });
  network.name.mockResolvedValue('');
  network.probe.mockImplementation(async (relays: string[]) =>
    Object.fromEntries(relays.map((url) => [url, true]))
  );
});

it('edits the relay pool while chat is off and checks reachability only on request', async () => {
  const store = configureStore({
    reducer: {
      experimental,
      preferences,
      wallet_id: () => ({ currentWalletId: 1 }),
    },
  });
  store.dispatch(setNostrChatEnabled(false));
  render(
    <Provider store={store}>
      <I18nProvider>
        <NostrSettings />
      </I18nProvider>
    </Provider>
  );
  expect(screen.queryByText('Nostr identity')).not.toBeInTheDocument();
  expect(screen.queryByText(/P2P-fusion transport/)).not.toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: /Check relay/i })
  ).toBeInTheDocument();
  fireEvent(document, new Event('visibilitychange'));
  const relay = 'wss://relay.user.example';
  fireEvent.change(screen.getByLabelText('Relay URL'), {
    target: { value: relay },
  });
  fireEvent.keyDown(screen.getByLabelText('Relay URL'), { key: 'Enter' });
  expect(selectNostrRelays(store.getState() as RootState)).toContain(relay);
  fireEvent.click(screen.getByRole('button', { name: `Remove ${relay}` }));
  expect(selectNostrRelays(store.getState() as RootState)).not.toContain(relay);
  expect(store.getState().experimental.nostrChatEnabled).toBe(false);
  expect(network.identity).not.toHaveBeenCalled();
  expect(network.probe).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: /Check relay/i }));
  await screen.findByText(/reachable at last check/);
  expect(network.probe).toHaveBeenCalledTimes(1);
  expect(network.probe).toHaveBeenCalledWith(
    selectNostrRelays(store.getState() as RootState),
    8000,
    expect.any(Function)
  );
  expect(store.getState().experimental.nostrChatEnabled).toBe(false);
});

it('keeps enablement, identity, profile loading and publishing together without automatic relay requests', async () => {
  const store = configureStore({
    reducer: {
      experimental,
      preferences,
      wallet_id: () => ({ currentWalletId: 1 }),
    },
  });
  store.dispatch(setNostrChatEnabled(true));
  render(
    <Provider store={store}>
      <I18nProvider>
        <NostrSettings />
      </I18nProvider>
    </Provider>
  );
  await screen.findByText('npub-test');
  expect(
    screen.getByRole('button', { name: /Disable Nostr chat/i })
  ).toBeInTheDocument();
  expect(network.profile).not.toHaveBeenCalled();
  expect(network.name).not.toHaveBeenCalled();
  expect(network.probe).not.toHaveBeenCalled();
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
  fireEvent.click(screen.getByRole('button', { name: /Disable Nostr chat/i }));
  expect(store.getState().experimental.nostrChatEnabled).toBe(false);
  expect(screen.queryByText('Nostr identity')).not.toBeInTheDocument();
  expect(screen.getByLabelText('Relay URL')).toBeInTheDocument();
});
