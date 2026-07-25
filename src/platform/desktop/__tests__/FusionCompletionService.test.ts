import { beforeEach, describe, expect, it, vi } from 'vitest';

const recordBroadcastMock = vi.fn();
const observeTransactionMock = vi.fn();
const refreshActiveWalletUtxosMock = vi.fn();

vi.mock('../../../services/OutboundTransactionTracker', () => ({
  default: {
    recordBroadcast: recordBroadcastMock,
  },
}));

vi.mock('../../../services/WalletBackendSyncService', () => ({
  default: {
    observeTransaction: observeTransactionMock,
  },
}));

vi.mock('../../../services/WalletUtxoRefreshService', () => ({
  refreshActiveWalletUtxos: refreshActiveWalletUtxosMock,
}));

describe('completeFusionBroadcast', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    recordBroadcastMock.mockResolvedValue({ state: 'broadcasted' });
    observeTransactionMock.mockResolvedValue(undefined);
    refreshActiveWalletUtxosMock.mockResolvedValue(true);
  });

  it('persists, observes, and immediately refreshes a completed Fusion transaction', async () => {
    const { completeFusionBroadcast } = await import(
      '../FusionCompletionService'
    );
    const spentInputs = [
      {
        tx_hash: 'a'.repeat(64),
        tx_pos: 0,
        address: 'bchtest:qinput',
        value: 200_000,
        height: 1,
      },
    ];

    await expect(
      completeFusionBroadcast({
        walletId: 5,
        txid: 'b'.repeat(64),
        txHex: '00',
        spentInputs,
        source: 'p2p-fusion',
        sourceLabel: 'P2P Fusion',
      })
    ).resolves.toEqual({ tracked: true, refreshed: true });

    expect(recordBroadcastMock).toHaveBeenCalledWith({
      walletId: 5,
      rawTx: '00',
      expectedTxid: 'b'.repeat(64),
      spentInputs,
      source: 'p2p-fusion',
      sourceLabel: 'P2P Fusion',
    });
    expect(observeTransactionMock).toHaveBeenCalledWith(
      5,
      'b'.repeat(64),
      '00'
    );
    expect(refreshActiveWalletUtxosMock).toHaveBeenCalledWith(5);
  });

  it('refreshes immediately even when backend observation does not resolve', async () => {
    observeTransactionMock.mockReturnValue(new Promise(() => {}));
    const { completeFusionBroadcast } = await import(
      '../FusionCompletionService'
    );

    await expect(
      completeFusionBroadcast({
        walletId: 5,
        txid: 'c'.repeat(64),
        txHex: '00',
        spentInputs: [],
        source: 'server-fusion',
        sourceLabel: 'CashFusion',
      })
    ).resolves.toEqual({ tracked: true, refreshed: true });

    expect(observeTransactionMock).toHaveBeenCalledOnce();
    expect(refreshActiveWalletUtxosMock).toHaveBeenCalledWith(5);
  });
});
