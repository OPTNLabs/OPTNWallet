import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UTXO } from '../../../types/types';

const getUTXOsManyMock = vi.fn();
const reconcileActiveWalletUtxosMock = vi.fn();
const reservedOutpointsMock = vi.fn();

vi.mock('../../../services/ElectrumService', () => ({
  default: {
    getUTXOsMany: getUTXOsManyMock,
  },
  invalidateUTXOCache: vi.fn(),
}));

vi.mock('../../../services/WalletUtxoRefreshService', () => ({
  reconcileActiveWalletUtxos: reconcileActiveWalletUtxosMock,
}));

vi.mock('../fusionRoundState', () => ({
  isOwnRoundKey: vi.fn(() => false),
  outpointKey: vi.fn((txHash: string, txPos: number) => `${txHash}:${txPos}`),
  recordRoundKey: vi.fn(),
  releaseOutpoints: vi.fn(),
  reserveOutpoints: vi.fn(),
  reservedOutpoints: reservedOutpointsMock,
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

describe('P2P Fusion input refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reservedOutpointsMock.mockReturnValue(new Set<string>());
  });

  it('replaces stale UI inputs with the wallet fresh live UTXOs', async () => {
    const stale: UTXO = {
      address: 'bchtest:qstale',
      height: 1,
      tx_hash: 'a'.repeat(64),
      tx_pos: 0,
      value: 50_000,
    };
    const fresh: UTXO = {
      address: 'bchtest:qfresh',
      height: 2,
      tx_hash: 'b'.repeat(64),
      tx_pos: 1,
      value: 75_000,
    };
    reconcileActiveWalletUtxosMock.mockResolvedValue({
      [fresh.address]: [fresh],
    });
    getUTXOsManyMock.mockResolvedValue({
      [fresh.address]: [fresh],
    });

    const fusionModule = (await import('../FusionP2pService')) as unknown as {
      refreshAndVerifyP2pInputs?: (
        walletId: number,
        fallback: UTXO[]
      ) => Promise<UTXO[]>;
    };

    expect(typeof fusionModule.refreshAndVerifyP2pInputs).toBe('function');
    await expect(
      fusionModule.refreshAndVerifyP2pInputs!(8, [stale])
    ).resolves.toEqual([fresh]);
    expect(getUTXOsManyMock).toHaveBeenCalledWith([fresh.address]);
  }, 15_000);
});
