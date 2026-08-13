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
