import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { afterEach, expect, it, vi } from 'vitest';
import { NostrSettings } from '../../../../features/nostr/NostrSettings';
import experimental, {
  setNostrChatEnabled,
  selectNostrRelays,
} from '../../../../state/slices/experimentalSlice';
import preferences from '../../../../state/slices/preferencesSlice';
import { I18nProvider } from '../../../../i18n/I18nProvider';
import type { RootState } from '../../../../state/store';

const network = vi.hoisted(() => ({ probe: vi.fn(), identity: vi.fn() }));
vi.mock('../../nostr/chat', () => ({
  checkRelayStatus: network.probe,
  myIdentity: network.identity,
  fetchProfile: vi.fn(),
  fetchPublishedDisplayName: vi.fn(),
  publishDisplayName: vi.fn(),
  publishMyProfile: vi.fn(),
}));
vi.mock('../../nostr/mls', () => ({
  claimExtraMlsDeviceSlot: vi.fn(),
  loadMlsDeviceIndex: vi.fn(),
  publishMlsKeyPackage: vi.fn(),
}));
vi.mock('../../../../components/WalletConfirmDialog', () => ({
  useWalletConfirm: () => vi.fn(),
}));
afterEach(cleanup);

it('edits the existing relay pool without probing, loading identity, or enabling chat', () => {
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
        <NostrSettings variant="relays" />
      </I18nProvider>
    </Provider>
  );
  expect(screen.queryByText('Nostr identity')).not.toBeInTheDocument();
  expect(screen.queryByText(/P2P-fusion transport/)).not.toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: /Check relay/i })
  ).not.toBeInTheDocument();
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
});
