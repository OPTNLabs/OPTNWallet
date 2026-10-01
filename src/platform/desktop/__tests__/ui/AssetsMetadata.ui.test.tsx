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
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineTokenIdentity } from '../../engineWalletBridge';
import type { UTXO } from '../../../../types/types';

type TestState = {
  wallet_id: { currentWalletId: number; sessionGeneration: number };
  network: { currentNetwork: string };
  appLock: { isLocked: boolean };
  utxos: {
    utxos: Record<string, UTXO[]>;
    totalBalance: number;
    initialized: boolean;
  };
  priceFeed: Record<string, { price: number }>;
};

const mocks = vi.hoisted(() => ({
  state: {} as TestState,
  listeners: new Set<() => void>(),
  invoke: vi.fn(),
  legacy: vi.fn(),
  chain: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('../../walletFile', () => ({
  findWalletFileRelForSourceId: async (id: number) => `wallets/test${id}.optn`,
}));
vi.mock('../../../../utils/platform', () => ({
  isDesktopPlatform: () => true,
}));
vi.mock('../../../../state/store', () => ({
  store: {
    getState: () => mocks.state,
    subscribe: (listener: () => void) => {
      mocks.listeners.add(listener);
      return () => mocks.listeners.delete(listener);
    },
  },
}));
vi.mock('react-redux', () => ({
  useSelector: (selector: (state: unknown) => unknown) => selector(mocks.state),
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('../../../../i18n/useI18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock('../../../../services/BcmrService', () => ({
  default: class {
    getSnapshot = mocks.legacy;
    getCategoryAuthbase = mocks.legacy;
    resolveIcon = mocks.legacy;
    resolveIdentityRegistry = mocks.legacy;
  },
}));
vi.mock('../../../../apis/ChaingraphManager/ChaingraphManager', () => ({
  queryTotalSupplyFT: mocks.chain,
  queryActiveMinting: mocks.chain,
  querySupplyNFTs: mocks.chain,
  queryAuthHead: mocks.chain,
  stripChaingraphHexBytes: mocks.chain,
}));
vi.mock('../../../../hooks/useFetchWalletData', () => ({ default: vi.fn() }));
vi.mock('../../../../features/rpa/StealthBalanceCard', () => ({
  StealthBalanceCard: () => null,
}));
vi.mock('../../../../features/cauldron/CauldronActivityCard', () => ({
  CauldronActivityCard: () => null,
}));
vi.mock('../../../../services/paryon/nftRegistry', () => ({
  resolveParyonNftParseInfo: () => null,
}));
vi.mock('../../../../components/transaction/Popup', () => ({
  default: ({ children }: { children: React.ReactNode }) => (
    <div role="dialog">{children}</div>
  ),
}));

import Assets from '../../../../pages/Assets';
import useSharedTokenMetadata, {
  getCachedTokenMetadata,
  preloadTokenMetadata,
  resolveTokenMetadata,
} from '../../../../hooks/useSharedTokenMetadata';
import TokenIdentityBadge from '../../../../components/ui/TokenIdentityBadge';
import { resolveTokenPresentation } from '../../../../utils/tokenPresentation';

const category = '0123456789abcdef'.repeat(4);
let identity: EngineTokenIdentity;
let runtimeWallet: string | null;
let runtimeEpoch: number;
let runtimeNetwork: string;

beforeEach(() => {
  vi.clearAllMocks();
  runtimeWallet = 'test1.optn';
  runtimeEpoch = 7;
  runtimeNetwork = 'chipnet';
  identity = {
    name: 'Authenticated token',
    ticker: 'AUTH',
    decimals: 2,
    status: 'verified',
    presentation: {
      description: 'Authenticated description',
      uris: {
        web: 'https://example.test/',
        icon: 'https://example.test/icon.png',
      },
      nfts: {
        parse: {
          types: {
            '01': {
              name: 'Authenticated collectible',
              uris: { icon: 'https://example.test/nft.png' },
            },
          },
        },
      },
    },
  };
  const coin: UTXO = {
    address: 'bchtest:test',
    tx_hash: '01'.repeat(32),
    tx_pos: 0,
    height: 1,
    value: 1000,
    token: {
      category,
      amount: 1234,
      nft: { commitment: '01', capability: 'none' },
      BcmrTokenMetadata: {
        name: 'Legacy provider name',
        description: '',
        is_nft: true,
        token: { category, symbol: 'OLD', decimals: 9 },
        uris: { icon: 'https://legacy.test/icon.png' },
        extensions: {},
      },
    },
  };
  mocks.state = {
    wallet_id: { currentWalletId: 1, sessionGeneration: 1 },
    network: { currentNetwork: 'chipnet' },
    appLock: { isLocked: false },
    utxos: { utxos: { test: [coin] }, totalBalance: 1000, initialized: true },
    priceFeed: {},
  };
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === 'optn_app_snapshot')
      return {
        version: 1,
        wallet: runtimeWallet ? {} : null,
        network: runtimeNetwork,
        unlock_epoch: runtimeEpoch,
        token_identities: { [category]: identity },
      };
    if (command === 'optn_wallet_security')
      return { active: runtimeWallet, epoch: runtimeEpoch };
    throw new Error(`Unexpected command ${command}`);
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function MetadataProbe() {
  const metadata = useSharedTokenMetadata([category])[category];
  return (
    <TokenIdentityBadge
      presentation={resolveTokenPresentation(category, metadata, {
        name: 'Legacy provider name',
        iconUri: 'https://legacy.test/icon.png',
      })}
    />
  );
}

function updateContext(update: () => void) {
  act(() => {
    update();
    for (const listener of mocks.listeners) listener();
  });
}

describe('retained desktop Assets metadata', () => {
  it('renders authenticated token details and NFT schema without provider or image requests', async () => {
    render(<Assets viewerOnly />);
    fireEvent.click(screen.getByRole('button', { name: 'assets.tabTokens' }));
    expect(await screen.findByText('Authenticated token')).toBeInTheDocument();
    expect(screen.getByText('12.34')).toBeInTheDocument();
    expect(screen.queryByText('Legacy provider name')).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: /Authenticated token/ })
    );
    expect(
      await screen.findByText('Authenticated description')
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Official Site' })).toHaveAttribute(
      'href',
      'https://example.test/'
    );
    fireEvent.click(screen.getByRole('button', { name: 'assets.tabNfts' }));
    expect(
      await screen.findByText('Authenticated collectible')
    ).toBeInTheDocument();
    expect(
      screen.queryAllByRole('img').map((img) => img.getAttribute('src'))
    ).toEqual(['/assets/images/OPTNWelcome1.png']);
    expect(mocks.legacy).not.toHaveBeenCalled();
    expect(mocks.chain).not.toHaveBeenCalled();
  });

  it('shows stale/reopened identity and then clears withdrawn metadata instead of reviving legacy cache', async () => {
    identity.status = 'stale';
    render(<MetadataProbe />);
    expect(await screen.findByText('Last known')).toBeInTheDocument();
    expect(screen.getByText('Authenticated token')).toBeInTheDocument();
    identity = { ...identity, status: 'unpublished' };
    fireEvent.focus(window);
    expect(
      await screen.findByText('No registry published')
    ).toBeInTheDocument();
    expect(screen.queryByText('Authenticated token')).not.toBeInTheDocument();
    expect(screen.queryByText('Legacy provider name')).not.toBeInTheDocument();
    expect(screen.queryAllByRole('img')).toHaveLength(0);
  });

  it('clears identity synchronously when renderer wallet/network/session changes or locks', async () => {
    render(<MetadataProbe />);
    expect(await screen.findByText('Authenticated token')).toBeInTheDocument();
    updateContext(() => {
      mocks.state.wallet_id.currentWalletId = 2;
    });
    expect(screen.queryByText('Authenticated token')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText('Unverified')).toBeInTheDocument()
    );
    runtimeWallet = 'test2.optn';
    runtimeEpoch = 8;
    fireEvent.focus(window);
    expect(await screen.findByText('Authenticated token')).toBeInTheDocument();
    updateContext(() => {
      mocks.state.network.currentNetwork = 'mainnet';
    });
    expect(screen.queryByText('Authenticated token')).not.toBeInTheDocument();
    runtimeNetwork = 'mainnet';
    fireEvent.focus(window);
    expect(await screen.findByText('Authenticated token')).toBeInTheDocument();
    updateContext(() => {
      mocks.state.wallet_id.sessionGeneration++;
    });
    expect(screen.queryByText('Authenticated token')).not.toBeInTheDocument();
    expect(await screen.findByText('Authenticated token')).toBeInTheDocument();
    updateContext(() => {
      mocks.state.appLock.isLocked = true;
    });
    expect(screen.queryByText('Authenticated token')).not.toBeInTheDocument();
  });

  it('observes runtime lock on the next snapshot and never falls back to legacy fetch', async () => {
    render(<MetadataProbe />);
    expect(await screen.findByText('Authenticated token')).toBeInTheDocument();
    runtimeWallet = null;
    runtimeEpoch++;
    fireEvent.focus(window);
    expect(await screen.findByText('Unverified')).toBeInTheDocument();
    expect(screen.queryByText('Authenticated token')).not.toBeInTheDocument();
    await preloadTokenMetadata([category]);
    expect(getCachedTokenMetadata(category)).toBeUndefined();
    expect((await resolveTokenMetadata(category))?.identityStatus).toBe(
      'unresolved'
    );
    expect(mocks.legacy).not.toHaveBeenCalled();
  });

  it('discards a response from a previous wallet after a new wallet is displayed', async () => {
    let releaseOld: (value: unknown) => void = () => {};
    const old = new Promise((resolve) => {
      releaseOld = resolve;
    });
    mocks.invoke.mockImplementationOnce(() => old);
    render(<MetadataProbe />);
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith('optn_app_snapshot')
    );
    runtimeWallet = 'test2.optn';
    runtimeEpoch = 8;
    identity = { ...identity, name: 'Second wallet token' };
    updateContext(() => {
      mocks.state.wallet_id.currentWalletId = 2;
    });
    expect(await screen.findByText('Second wallet token')).toBeInTheDocument();
    await act(async () =>
      releaseOld({
        version: 1,
        wallet: {},
        network: 'chipnet',
        unlock_epoch: 7,
        token_identities: {
          [category]: { ...identity, name: 'Previous wallet token' },
        },
      })
    );
    expect(screen.queryByText('Previous wallet token')).not.toBeInTheDocument();
    expect(screen.getByText('Second wallet token')).toBeInTheDocument();
  });
});
