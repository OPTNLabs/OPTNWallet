import { beforeEach, expect, it, vi } from 'vitest';
import { Network } from '../../../state/slices/networkSlice';

const { invoke, birth } = vi.hoisted(() => ({
  invoke: vi.fn(),
  birth: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('../DesktopWalletManager', () => ({ getBirthHeight: birth }));
vi.mock('../../../services/KeyService', () => ({
  default: {
    retrieveKeys: async () => [
      { pubkeyHash: new Uint8Array(20), address: 'test' },
    ],
  },
}));
import { nodeSync } from '../Bip37Backend';

beforeEach(() => {
  vi.clearAllMocks();
  birth.mockResolvedValue(102);
});

it('refuses a resumed header walk without cursor metadata before network I/O', async () => {
  await expect(
    nodeSync('localhost', 48333, Network.CHIPNET, 7, { fromHash: 'saved' })
  ).rejects.toThrow(/height and time/);
  expect(invoke).not.toHaveBeenCalled();
});

it('passes the saved cursor and applies birth height relative to it', async () => {
  invoke
    .mockResolvedValueOnce([
      { hash: 'h101', prev_hash: 'saved', time: 1010, bits: 0 },
      { hash: 'h102', prev_hash: 'h101', time: 1020, bits: 0 },
    ])
    .mockResolvedValueOnce({ owned: [], spent: [], scanned_blocks: 1 });
  await nodeSync('localhost', 48333, Network.CHIPNET, 7, {
    fromHash: 'saved',
    fromHeight: 100,
    fromTime: 1000,
  });
  expect(invoke).toHaveBeenNthCalledWith(
    1,
    'bip37_headers',
    expect.objectContaining({
      locator: 'saved',
      locatorHeight: 100,
      locatorTime: 1000,
    })
  );
  expect(invoke).toHaveBeenNthCalledWith(
    2,
    'bip37_scan',
    expect.objectContaining({
      blockHashes: ['h102'],
    })
  );
});
