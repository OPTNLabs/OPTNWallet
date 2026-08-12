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
    retrieveKeys
      .mockResolvedValueOnce([
        {
          accountIndex: 0,
          changeIndex: 0,
          addressIndex: 4,
          address: 'bchtest:q4',
        },
      ])
      .mockResolvedValueOnce([
        {
          accountIndex: 0,
          changeIndex: 0,
          addressIndex: 4,
          address: 'bchtest:q4',
        },
        {
          accountIndex: 0,
          changeIndex: 0,
          addressIndex: 5,
          address: 'bchtest:q5',
        },
        {
          accountIndex: 0,
          changeIndex: 0,
          addressIndex: 6,
          address: 'bchtest:q6',
        },
      ]);

    await expect(
      createFreshFusionOutputScripts(7, Network.CHIPNET, 2)
    ).resolves.toEqual(['05', '06']);

    expect(createKeys).toHaveBeenNthCalledWith(1, 7, 0, 0, 5);
    expect(createKeys).toHaveBeenNthCalledWith(2, 7, 0, 0, 6);
  });
});
