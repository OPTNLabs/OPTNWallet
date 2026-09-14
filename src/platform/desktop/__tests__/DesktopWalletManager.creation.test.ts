import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Network } from '../../../state/slices/networkSlice';

const mocks = vi.hoisted(() => ({
  tip: vi.fn(),
  run: vi.fn(),
  save: vi.fn(),
}));
vi.mock('../../../apis/WalletManager/WalletManager', () => ({
  default: () => ({ createWallet: async () => true }),
}));
vi.mock('../../../apis/DatabaseManager/DatabaseService', () => ({
  default: () => ({
    ensureDatabaseStarted: async () => {},
    flushDatabaseToFile: async () => {},
    getDatabase: () => ({
      run: mocks.run,
      prepare: () => ({
        bind: () => {},
        run: () => {},
        step: () => true,
        getAsObject: () => ({ id: 7 }),
        free: () => {},
      }),
    }),
  }),
}));
vi.mock('../../../services/ElectrumService', () => ({
  default: { getLatestBlock: mocks.tip },
}));
vi.mock('../WalletCrypto', async (original) => ({
  ...(await original<typeof import('../WalletCrypto')>()),
  deriveKey: async () => ({}),
  aesEncrypt: async () => 'test-ciphertext',
}));
vi.mock('../walletFile', async (original) => ({
  ...(await original<typeof import('../walletFile')>()),
  autoSaveWalletFile: mocks.save,
}));
import { createWalletWithPassword } from '../DesktopWalletManager';
import { clearCachedPassword } from '../WalletKeyCache';

const creationArgs = {
  name: 'Offline creation fixture',
  mnemonic: 'unused by mocked wallet manager',
  passphrase: '',
  network: Network.CHIPNET,
  password: 'public-test-password',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});
afterEach(() => {
  clearCachedPassword();
  vi.useRealTimers();
});

it('finishes local creation when birth-height discovery stalls, without persisting a late tip', async () => {
  let resolveTip!: (tip: { height: number }) => void;
  mocks.tip.mockReturnValue(
    new Promise((resolve) => {
      resolveTip = resolve;
    })
  );
  const creation = createWalletWithPassword(creationArgs);
  await vi.waitFor(() => expect(mocks.tip).toHaveBeenCalledOnce());
  await vi.advanceTimersByTimeAsync(5000);
  await expect(creation).resolves.toBe(7);
  expect(mocks.save).toHaveBeenCalledOnce();
  resolveTip({ height: 323133 });
  await Promise.resolve();
  expect(
    mocks.run.mock.calls.some(([sql]) => sql.includes('birth_height'))
  ).toBe(false);
});

it('persists an available birth height and clears the deadline', async () => {
  mocks.tip.mockResolvedValue({ height: 323133 });
  await expect(createWalletWithPassword(creationArgs)).resolves.toBe(7);
  expect(mocks.run).toHaveBeenCalledWith(
    'UPDATE wallets SET birth_height = ? WHERE id = ?',
    [323133, 7]
  );
  expect(vi.getTimerCount()).toBe(0);
});
