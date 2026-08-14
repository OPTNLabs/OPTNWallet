import { beforeEach, describe, expect, it, vi } from 'vitest';

import WalletManager from '../../../apis/WalletManager/WalletManager';
import DatabaseService from '../../../apis/DatabaseManager/DatabaseService';
import { Network } from '../../../state/slices/networkSlice';
import { WalletType } from '../../../types/wallet';
import { openWatchOnlyWallet } from '../DesktopWalletManager';
import {
  clearWatchOnlySession,
  hasCachedCredentialsForWallet,
  hasWatchOnlySession,
  markWatchOnlySession,
} from '../WalletKeyCache';
import { WATCH_ONLY_WALLET_TYPE } from '../onboarding/watchOnlyWallet';

const ensureWatchOnlyWalletKeys = vi.fn(async () => ({
  keyCount: 40,
  rebuilt: false,
  firstReceive: 'bchtest:qtest',
}));
const ensureWatchOnlyWalletAddresses = vi.fn(async () => 0);

vi.mock('../../../apis/WalletManager/WalletManager', () => ({
  default: vi.fn(),
}));

vi.mock('../../../apis/DatabaseManager/DatabaseService', () => ({
  default: vi.fn(),
}));

vi.mock('../../../services/QuantumrootVaultCacheService', () => ({
  default: {
    clear: vi.fn(),
  },
}));

vi.mock('../onboarding/watchOnlyWallet', async () => {
  const actual = await vi.importActual<
    typeof import('../onboarding/watchOnlyWallet')
  >('../onboarding/watchOnlyWallet');
  return {
    ...actual,
    ensureWatchOnlyWalletKeys: (...args: unknown[]) =>
      ensureWatchOnlyWalletKeys(...args),
    ensureWatchOnlyWalletAddresses: (...args: unknown[]) =>
      ensureWatchOnlyWalletAddresses(...args),
  };
});

const watchOnlyMetadata = {
  id: 9,
  wallet_name: 'Cold watch',
  networkType: Network.CHIPNET,
  walletType: WATCH_ONLY_WALLET_TYPE,
  balance: 0,
  derivation_path: "m/44'/145'/0'",
  derivation_path_source: 'default',
} as const;

const standardMetadata = {
  id: 7,
  wallet_name: 'Hot wallet',
  networkType: Network.MAINNET,
  walletType: WalletType.STANDARD,
  balance: 0,
  derivation_path: "m/44'/145'/0'",
  derivation_path_source: 'default',
} as const;

describe('openWatchOnlyWallet', () => {
  const mockedWalletManager = vi.mocked(WalletManager);
  const mockedDatabaseService = vi.mocked(DatabaseService);

  beforeEach(() => {
    vi.clearAllMocks();
    clearWatchOnlySession();
    mockedWalletManager.mockReturnValue({
      getWalletMetadata: vi.fn(),
    } as never);
    mockedDatabaseService.mockReturnValue({
      ensureDatabaseStarted: vi.fn(async () => {}),
      getDatabase: vi.fn(() => null),
    } as never);
  });

  it('opens a watch-only wallet and marks its session, with no credentials', async () => {
    mockedWalletManager().getWalletMetadata = vi.fn(async () => ({
      ...watchOnlyMetadata,
    }));

    const info = await openWatchOnlyWallet(9);

    expect(info?.walletType).toBe(WATCH_ONLY_WALLET_TYPE);
    expect(hasWatchOnlySession(9)).toBe(true);
    expect(hasCachedCredentialsForWallet(9)).toBe(true);
    // Parity with hardware open: rebuild/dual-write keys so empty tables cannot
    // leave Home stuck at 0 forever after funds arrive on-chain.
    expect(ensureWatchOnlyWalletKeys).toHaveBeenCalledWith(9);
    expect(ensureWatchOnlyWalletAddresses).toHaveBeenCalledWith(9);
  });

  it('refuses to open a standard wallet through the watch-only door', async () => {
    mockedWalletManager().getWalletMetadata = vi.fn(async () => ({
      ...standardMetadata,
    }));

    const info = await openWatchOnlyWallet(7);

    expect(info).toBeNull();
    expect(hasWatchOnlySession(7)).toBe(false);
    expect(hasCachedCredentialsForWallet(7)).toBe(false);
  });

  it('returns null for a missing wallet and leaves no session behind', async () => {
    mockedWalletManager().getWalletMetadata = vi.fn(async () => null);

    const info = await openWatchOnlyWallet(404);

    expect(info).toBeNull();
    expect(hasWatchOnlySession()).toBe(false);
  });

  it('clears the watch-only marker when credentials are wiped (lock)', async () => {
    markWatchOnlySession(9);

    const { clearCachedPassword } = await import('../WalletKeyCache');
    clearCachedPassword();

    expect(hasWatchOnlySession(9)).toBe(false);
    expect(hasCachedCredentialsForWallet(9)).toBe(false);
  });
});
