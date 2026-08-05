import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UTXO } from '../../../types/types';

const getUTXOsManyMock = vi.fn();
const broadcastTransactionMock = vi.fn();
const getTransactionVisibilityMock = vi.fn();
const reconcileActiveWalletUtxosMock = vi.fn();
const reservedOutpointsMock = vi.fn();

vi.mock('../../../services/ElectrumService', () => ({
  default: {
    getUTXOsMany: getUTXOsManyMock,
    broadcastTransaction: broadcastTransactionMock,
    getTransactionVisibility: getTransactionVisibilityMock,
  },
  invalidateUTXOCache: vi.fn(),
}));

vi.mock('../../../services/WalletUtxoRefreshService', () => ({
  reconcileActiveWalletUtxosForSpend: reconcileActiveWalletUtxosMock,
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

describe('P2P Fusion broadcast reconciliation', () => {
  const txHex = '01000000000000000000';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function broadcaster() {
    const fusionModule = await import('../FusionP2pService');
    return fusionModule.broadcastP2pTransaction;
  }

  it('accepts the exact locally derived txid from Electrum', async () => {
    const broadcast = await broadcaster();
    const expected = (
      await broadcast(txHex, {
        broadcast: async () => {
          const { binToHex, hexToBin } = await import('../../../utils/hex');
          const { hash256 } = await import('@bitauth/libauth');
          return binToHex(hash256(hexToBin(txHex)).reverse());
        },
        visibility: async () => ({ seen: false, confirmed: false }),
      })
    ).txid;

    await expect(
      broadcast(txHex, {
        broadcast: async () => expected,
        visibility: async () => ({ seen: false, confirmed: false }),
      })
    ).resolves.toEqual({ txid: expected, verified: true });
  });

  it('recovers when the node accepted the tx but its response was lost', async () => {
    const broadcast = await broadcaster();
    let expected = '';

    const receipt = await broadcast(txHex, {
      broadcast: async () => 'Connection lost',
      visibility: async (txid) => {
        expected = txid;
        return { seen: true, confirmed: false };
      },
    });

    expect(receipt).toEqual({ txid: expected, verified: true });
  });

  it('tracks an ambiguous broadcast instead of falsely reporting rejection', async () => {
    const broadcast = await broadcaster();

    const receipt = await broadcast(txHex, {
      broadcast: async () => {
        throw new Error('request timed out');
      },
      visibility: async () => ({ seen: false, confirmed: false }),
    });

    expect(receipt.verified).toBe(false);
    expect(receipt.txid).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.warning).toMatch(/not yet confirmed/i);
  });

  it('still rejects an explicit node-policy failure', async () => {
    const broadcast = await broadcaster();

    await expect(
      broadcast(txHex, {
        broadcast: async () =>
          'mempool min fee not met, 219 < 233 (code 66)',
        visibility: async () => ({ seen: false, confirmed: false }),
      })
    ).rejects.toThrow(/broadcast rejected/i);
  });
});
