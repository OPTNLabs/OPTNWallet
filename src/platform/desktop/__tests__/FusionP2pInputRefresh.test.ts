import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UTXO } from '../../../types/types';
import { Network } from '../../../state/slices/networkSlice';

const getUTXOsManyMock = vi.fn();
const broadcastTransactionMock = vi.fn();
const getTransactionVisibilityMock = vi.fn();
const reconcileActiveWalletUtxosMock = vi.fn();
const reservedOutpointsMock = vi.fn();
const invokeMock = vi.fn();

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
  invoke: invokeMock,
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

  it('keeps exclusive-reconciled coins when a second listunspent is empty (0-conf lag)', async () => {
    const coin: UTXO = {
      address: 'bchtest:qfresh',
      height: 0,
      tx_hash: 'c'.repeat(64),
      tx_pos: 0,
      value: 40_000,
    };
    getUTXOsManyMock.mockResolvedValue({
      [coin.address]: [], // Electrum not listing 0-conf yet
    });

    const fusionModule = (await import('../FusionP2pService')) as unknown as {
      refreshAndVerifyP2pInputs?: (
        walletId: number,
        fallback: UTXO[],
        signal?: AbortSignal,
        options?: { preferProvided?: boolean }
      ) => Promise<UTXO[]>;
    };

    await expect(
      fusionModule.refreshAndVerifyP2pInputs!(8, [coin], undefined, {
        preferProvided: true,
      })
    ).resolves.toEqual([coin]);
  }, 15_000);

  it('reserves credential capacity for the maximum six output components', async () => {
    const coins: UTXO[] = Array.from({ length: 30 }, (_, index) => ({
      address: `bchtest:q${index}`,
      height: 1,
      tx_hash: index.toString(16).padStart(64, '0'),
      tx_pos: 0,
      value: 10_000 + index,
    }));
    const fusionModule = (await import('../FusionP2pService')) as unknown as {
      selectFusionInputs?: (utxos: UTXO[]) => UTXO[];
    };

    expect(typeof fusionModule.selectFusionInputs).toBe('function');
    const selected = fusionModule.selectFusionInputs!(coins);
    expect(selected).toHaveLength(18);
    expect(selected[0].value).toBe(10_029);
  });
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

  it('uses only native Tor relay and Tor-routed observation in production', async () => {
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
    invokeMock
      .mockResolvedValueOnce({
        txid: expected,
        relaySubmitted: true,
        observerSeen: false,
      })
      .mockResolvedValueOnce(true);

    const { broadcastP2pTransactionTorOnly } = await import(
      '../FusionP2pService'
    );
    await expect(
      broadcastP2pTransactionTorOnly(txHex, Network.CHIPNET, {
        host: '127.0.0.1',
        port: 9251,
      })
    ).resolves.toEqual({ txid: expected, verified: true });

    expect(invokeMock.mock.calls.map(([command]) => command)).toEqual([
      'fusion_relay_broadcast_and_observe',
    ]);
    expect(broadcastTransactionMock).not.toHaveBeenCalled();
    expect(getTransactionVisibilityMock).not.toHaveBeenCalled();
    expect(invokeMock.mock.calls[0][1]).toMatchObject({
      txHex,
      network: Network.CHIPNET,
      torHost: '127.0.0.1',
      torPort: 9251,
    });
  });
});

describe('P2P Fusion native signing boundary', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    reservedOutpointsMock.mockReturnValue(new Set<string>());
  });

  it('binds the exact v3 template and converts only native-owned signatures', async () => {
    const pubkey = `02${'11'.repeat(32)}`;
    const input = {
      prevTxid: '22'.repeat(32),
      prevIndex: 3,
      value: 100_000,
      pubkey,
    };
    const output = { script: `76a914${'33'.repeat(20)}88ac`, value: 99_500 };
    invokeMock.mockImplementation(async (command, args) => {
      if (command !== 'fusion_p2p_sign') return undefined;
      const request = (args as { request: Record<string, unknown> }).request as {
        protocol: string;
        network: string;
        session: string;
        transcriptHash: string;
        templateHash: string;
        ownedInputs: Array<Record<string, unknown>>;
        ownedOutputs: Array<Record<string, unknown>>;
        feerate: number;
      };
      expect(request).toMatchObject({
        protocol: 'p2p-v3',
        network: 'chipnet',
        session: '44'.repeat(32),
        feerate: 1_000,
      });
      expect(request.transcriptHash).toMatch(/^[0-9a-f]{64}$/);
      expect(request.templateHash).toMatch(/^[0-9a-f]{64}$/);
      expect(request.ownedInputs).toEqual([
        { ...input, privateKey: '55'.repeat(32) },
      ]);
      expect(request.ownedOutputs).toEqual([output]);
      return {
        protocol: 'p2p-v3',
        templateHash: request.templateHash,
        fee: 500,
        signatures: [
          {
            outpoint: `${input.prevTxid}:${input.prevIndex}`,
            signature: '66'.repeat(64),
          },
        ],
      };
    });

    const { nativeSignP2pInputs } = await import('../FusionP2pService');
    const signatures = await nativeSignP2pInputs({
      tx: { inputs: [input], outputs: [output] },
      myContribution: { inputs: [input], outputs: [output] },
      keysByPubkey: new Map([[pubkey, Uint8Array.from({ length: 32 }, () => 0x55)]]),
      network: 'chipnet',
      session: '44'.repeat(32),
      participants: ['77'.repeat(32), '88'.repeat(32), '99'.repeat(32)],
      tier: 100_000,
      feerate: 1_000,
    });

    expect(signatures).toEqual([
      {
        prevTxid: input.prevTxid,
        prevIndex: input.prevIndex,
        unlockingBytecode: `41${'66'.repeat(64)}4121${pubkey}`,
      },
    ]);
  });
});
