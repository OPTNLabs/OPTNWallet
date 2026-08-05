import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createKeys, retrieveKeys } = vi.hoisted(() => ({
  createKeys: vi.fn(),
  retrieveKeys: vi.fn(),
}));

vi.mock('../../../services/KeyService', () => ({
  default: { createKeys, retrieveKeys },
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

vi.mock('@bitauth/libauth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@bitauth/libauth')>();
  return {
    ...actual,
    cashAddressToLockingBytecode: vi.fn((address: string) => ({
      bytecode: new Uint8Array([Number(address.slice(-1))]),
    })),
  };
});

import { Network } from '../../../state/slices/networkSlice';
import { createFreshFusionOutputScripts } from '../FusionService';

describe('Fusion output persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('persists each fresh receive key before returning its locking script', async () => {
    const key = (
      addressIndex: number,
      address: string
    ) => ({
      accountIndex: 0,
      changeIndex: 0,
      addressIndex,
      address,
    });

    // Allocator re-reads occupied indexes before each mint, then once at end.
    retrieveKeys
      .mockResolvedValueOnce([key(4, 'bchtest:q4')])
      .mockResolvedValueOnce([key(4, 'bchtest:q4')])
      .mockResolvedValueOnce([key(4, 'bchtest:q4'), key(5, 'bchtest:q5')])
      .mockResolvedValueOnce([
        key(4, 'bchtest:q4'),
        key(5, 'bchtest:q5'),
        key(6, 'bchtest:q6'),
      ]);

    await expect(
      createFreshFusionOutputScripts(7, Network.CHIPNET, 2)
    ).resolves.toEqual(['05', '06']);

    expect(createKeys).toHaveBeenNthCalledWith(1, 7, 0, 0, 5);
    expect(createKeys).toHaveBeenNthCalledWith(2, 7, 0, 0, 6);
  });

  it('skips ahead when a concurrent mint already took the next index', async () => {
    const key = (addressIndex: number, address: string) => ({
      accountIndex: 0,
      changeIndex: 0,
      addressIndex,
      address,
    });

    createKeys
      .mockRejectedValueOnce(
        new Error('UNIQUE constraint failed: keys.token_address')
      )
      .mockResolvedValueOnce(undefined);

    retrieveKeys
      .mockResolvedValueOnce([key(4, 'bchtest:q4')])
      .mockResolvedValueOnce([key(4, 'bchtest:q4')])
      // After UNIQUE, allocator advances and re-reads; index 5 now occupied.
      .mockResolvedValueOnce([key(4, 'bchtest:q4'), key(5, 'bchtest:q5')])
      .mockResolvedValueOnce([
        key(4, 'bchtest:q4'),
        key(5, 'bchtest:q5'),
        key(6, 'bchtest:q6'),
      ]);

    await expect(
      createFreshFusionOutputScripts(7, Network.CHIPNET, 1)
    ).resolves.toEqual(['06']);

    expect(createKeys).toHaveBeenNthCalledWith(1, 7, 0, 0, 5);
    expect(createKeys).toHaveBeenNthCalledWith(2, 7, 0, 0, 6);
  });
});
