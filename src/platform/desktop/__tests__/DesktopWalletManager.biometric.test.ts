import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Network } from '../../../state/slices/networkSlice';
import { WalletType } from '../../../types/wallet';

const mocks = vi.hoisted(() => ({
  biometric: vi.fn(),
  decrypt: vi.fn(),
  metadata: vi.fn(),
  bootstrap: vi.fn(),
  engine: vi.fn(),
  cached: vi.fn(),
  prepare: vi.fn(),
}));
vi.mock('@choochmeque/tauri-plugin-biometry-api', () => ({
  getData: mocks.biometric,
}));
vi.mock('../engineWalletBridge', () => ({ openWalletInEngine: mocks.engine }));
vi.mock('../../../apis/WalletManager/WalletManager', () => ({
  default: () => ({ getWalletMetadata: mocks.metadata }),
}));
vi.mock('../../../apis/DatabaseManager/DatabaseService', () => ({
  default: () => ({
    ensureDatabaseStarted: async () => {},
    getDatabase: () => ({ prepare: mocks.prepare }),
  }),
}));
vi.mock('../../../services/KeyService', () => ({
  default: { bootstrapInitialAddressBatch: mocks.bootstrap },
}));
vi.mock('../../../services/QuantumrootVaultCacheService', () => ({
  default: { clear: vi.fn() },
}));
vi.mock('../WalletCrypto', async (original) => ({
  ...(await original<typeof import('../WalletCrypto')>()),
  deriveKey: async () => ({}),
  aesDecrypt: mocks.decrypt,
}));
vi.mock('../WalletKeyCache', async (original) => ({
  ...(await original<typeof import('../WalletKeyCache')>()),
  getCachedPasswordSnapshot: mocks.cached,
  setCachedPassword: vi.fn(),
  clearCachedPassword: vi.fn(),
}));
vi.mock('../DeviceIntegrityService', () => ({
  markSpendAuthFromUnlock: vi.fn(),
}));

import {
  openWalletWithPassword,
  unlockWalletWithBiometric,
} from '../DesktopWalletManager';

const metadata = {
  id: 7,
  wallet_name: 'Public fixture',
  networkType: Network.CHIPNET,
  walletType: WalletType.STANDARD,
  balance: null,
  derivation_path: "m/44'/1'/4'",
  derivation_path_source: 'custom',
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.biometric.mockResolvedValue({ data: 'synthetic-os-password' });
  mocks.decrypt.mockResolvedValue('synthetic-authentication-fixture');
  mocks.cached.mockReturnValue(null);
  mocks.metadata.mockResolvedValue(metadata);
  mocks.bootstrap.mockResolvedValue(undefined);
  mocks.engine.mockResolvedValue({ opened: true });
  mocks.prepare.mockImplementation((query: string) => {
    const row = query.includes('kdf_salt')
      ? { kdf_salt: 'AQID' }
      : query.includes('SELECT mnemonic')
        ? { mnemonic: 'enc:v1:synthetic-ciphertext' }
        : {
            network_cleanup_version: 1,
            network_cleanup_network: Network.CHIPNET,
          };
    return {
      bind: vi.fn(),
      step: () => true,
      getAsObject: () => row,
      free: vi.fn(),
    };
  });
});

describe('biometric engine handoff', () => {
  it('uses the verified OS credential after public bootstrap and returns no credential', async () => {
    const result = await unlockWalletWithBiometric(7, 30);
    expect(mocks.biometric).toHaveBeenCalledExactlyOnceWith({
      domain: 'com.optilabs.wallet',
      name: 'optn-wallet-bio-7',
      reason: 'Unlock OPTN Wallet',
    });
    expect(mocks.bootstrap).toHaveBeenCalledExactlyOnceWith(7, 4, 1);
    expect(mocks.engine).toHaveBeenCalledExactlyOnceWith(
      7,
      'synthetic-os-password',
      30
    );
    expect(mocks.decrypt.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.bootstrap.mock.invocationCallOrder[0]
    );
    expect(mocks.bootstrap.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.engine.mock.invocationCallOrder[0]
    );
    expect(result).toEqual({ ...metadata, engineWarning: undefined });
    // Only the pre-existing rollback snapshot in openWalletWithPassword reads it.
    expect(mocks.cached).toHaveBeenCalledOnce();
  });

  it('returns engine refusal as nonsecret feedback without undoing biometric unlock', async () => {
    mocks.engine.mockResolvedValueOnce({
      opened: false,
      reason: 'HD inventory persistence failed.',
    });
    await expect(unlockWalletWithBiometric(7)).resolves.toEqual({
      ...metadata,
      engineWarning: 'HD inventory persistence failed.',
    });
    expect(mocks.engine).toHaveBeenCalledWith(
      7,
      'synthetic-os-password',
      undefined
    );
  });

  it('preserves unlock if the bridge unexpectedly rejects', async () => {
    mocks.engine.mockRejectedValueOnce(
      new Error('synthetic transport failure')
    );
    await expect(unlockWalletWithBiometric(7, 0)).resolves.toEqual({
      ...metadata,
      engineWarning: 'Wallet opened, but the shared engine is unavailable.',
    });
  });

  it('does not call the bridge when the OS prompt is cancelled', async () => {
    mocks.biometric.mockRejectedValueOnce(new Error('cancelled'));
    await expect(unlockWalletWithBiometric(7, 30)).rejects.toThrow('cancelled');
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.engine).not.toHaveBeenCalled();
  });

  it('does not hand off a stored credential that fails the existing password check', async () => {
    mocks.decrypt.mockRejectedValueOnce(new Error('wrong password'));
    await expect(unlockWalletWithBiometric(7, 30)).rejects.toThrow(
      'saved password no longer opens'
    );
    expect(mocks.bootstrap).not.toHaveBeenCalled();
    expect(mocks.engine).not.toHaveBeenCalled();
  });

  it('uses the public account index for direct password bootstrap too', async () => {
    await expect(
      openWalletWithPassword(7, 'synthetic-password')
    ).resolves.toEqual(metadata);
    expect(mocks.bootstrap).toHaveBeenCalledExactlyOnceWith(7, 4, 1);
    expect(mocks.engine).not.toHaveBeenCalled();
  });
});
