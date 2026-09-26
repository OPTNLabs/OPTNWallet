import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendTransactionMock = vi.fn();
const addOutputMock = vi.fn();
const trackAttemptMock = vi.fn();
const listActiveMock = vi.fn();
const removeMock = vi.fn();
const retrieveKeysMock = vi.fn();
const requestRefreshMock = vi.fn();
const reservedFusionOutpointsMock = vi.fn();
const refreshMultisigWalletUtxosMock = vi.fn();
const buildTransactionMock = vi.fn();
const holdMocks = vi.hoisted(() => ({
  desktop: true,
  invoke: vi.fn(),
  verify: vi.fn(),
  state: {
    network: { currentNetwork: 'chipnet' },
    wallet_id: {
      currentWalletId: 11,
      networkType: 'chipnet',
      sessionGeneration: 1,
    },
  },
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: holdMocks.invoke }));
vi.mock('../../utils/platform', () => ({
  isDesktopPlatform: () => holdMocks.desktop,
}));
vi.mock('../../platform/desktop/WalletLedgerService', () => ({
  verifyOutpointsStillUnspent: holdMocks.verify,
}));

// Unsigned public fixture; neither signing nor network access is needed.
const INPUT_TXID = '0123456789abcdef'.repeat(4);
const INPUT_WIRE = 'efcdab8967452301'.repeat(4);
const RAW_TX = `0200000001${INPUT_WIRE}0000000000ffffffff01e803000000000000015100000000`;
const heldCoin = (reason = 'user') => ({
  txid: INPUT_TXID,
  vout: 0,
  outpoint: `${INPUT_TXID}:0`,
  reason,
  note: null,
  user_reversible: reason === 'user',
});

vi.mock('../../apis/TransactionManager/TransactionManager', () => ({
  default: () => ({
    sendTransaction: sendTransactionMock,
    buildTransaction: buildTransactionMock,
    addOutput: addOutputMock,
  }),
}));

vi.mock('../OutboundTransactionTracker', () => ({
  default: {
    listActive: listActiveMock,
    trackAttempt: trackAttemptMock,
    remove: removeMock,
  },
  deriveTrackedTxid: vi.fn((rawTx: string) => `tracked:${rawTx}`),
}));

vi.mock('../../apis/DatabaseManager/DatabaseService', () => ({
  default: vi.fn(),
}));

vi.mock('../KeyService', () => ({
  default: {
    retrieveKeys: retrieveKeysMock,
  },
}));

vi.mock('../../workers/UTXOWorkerService', () => ({
  optimisticRemoveSpentByOutpoints: vi.fn(),
  requestUTXORefreshForMany: requestRefreshMock,
}));

vi.mock('../WalletBackendSyncService', () => ({
  default: { observeTransaction: vi.fn() },
}));

vi.mock('../WalletUtxoRefreshService', () => ({
  refreshMultisigWalletUtxos: refreshMultisigWalletUtxosMock,
}));

vi.mock('../../platform/desktop/fusionRoundState', () => ({
  reservedOutpoints: (...args: unknown[]) =>
    reservedFusionOutpointsMock(...args),
}));

vi.mock('../../state/store', () => ({
  store: {
    getState: () => holdMocks.state,
  },
}));

describe('TransactionService.sendTransaction', () => {
  beforeEach(async () => {
    // sendTransaction kicks off tracker and refresh work without awaiting it, so
    // the previous test's calls can still be in flight. Clearing the mocks first
    // lets a stray call land inside THIS test, and the assertions here are
    // negative — not.toHaveBeenCalled() — so a late arrival fails a test that
    // never triggered it. Red only under parallel load, green in isolation.
    // Let the detached work settle before resetting the counters.
    await new Promise((resolve) => setTimeout(resolve, 0));
    vi.clearAllMocks();
    holdMocks.desktop = true;
    listActiveMock.mockResolvedValue([]);
    retrieveKeysMock.mockResolvedValue([]);
    reservedFusionOutpointsMock.mockReturnValue(new Set());
    refreshMultisigWalletUtxosMock.mockResolvedValue({});
    holdMocks.invoke.mockReset().mockResolvedValue([]);
    holdMocks.verify.mockReset().mockResolvedValue({ ok: true });
    holdMocks.state.wallet_id = {
      currentWalletId: 11,
      networkType: 'chipnet',
      sessionGeneration: 1,
    };
  });

  it('clears any pending outbound record when broadcast returns an error', async () => {
    sendTransactionMock.mockResolvedValue({
      txid: 'deadbeef',
      errorMessage:
        'Error sending transaction: mandatory-script-verify-flag-failed',
    });

    const { default: TransactionService } = await import(
      '../TransactionService'
    );

    const result = await TransactionService.sendTransaction(RAW_TX);

    expect(result.errorMessage).toContain(
      'mandatory-script-verify-flag-failed'
    );
    expect(trackAttemptMock).not.toHaveBeenCalled();
    expect(removeMock).toHaveBeenCalledWith(`tracked:${RAW_TX}`, 11);
    expect(requestRefreshMock).not.toHaveBeenCalled();
  });

  it('keeps rejected multisig spends route-scoped and refreshes their coins', async () => {
    sendTransactionMock.mockResolvedValue({
      txid: null,
      errorMessage: 'Broadcast rejected for insufficient fee.',
    });

    const { default: TransactionService } = await import(
      '../TransactionService'
    );

    const result = await TransactionService.sendTransaction(RAW_TX, undefined, {
      walletId: 42,
      multisig: true,
    });

    expect(result.errorMessage).toContain('insufficient fee');
    expect(sendTransactionMock).toHaveBeenCalledWith(RAW_TX, 42);
    expect(holdMocks.invoke).toHaveBeenCalledWith('optn_coin_holds', {
      walletId: 42,
    });
    expect(removeMock).toHaveBeenCalledWith(`tracked:${RAW_TX}`, 42);
    expect(removeMock).toHaveBeenCalledWith(`tracked:${RAW_TX}`, 11);
    expect(refreshMultisigWalletUtxosMock).toHaveBeenCalledWith(42);
  });

  it('allows a new send when the syncing transaction reserved different inputs', async () => {
    listActiveMock.mockResolvedValue([
      {
        txid: 'old',
        spentOutpoints: [{ tx_hash: 'old-input', tx_pos: 0 }],
      },
    ]);
    sendTransactionMock.mockResolvedValue({
      txid: 'new-txid',
      errorMessage: null,
      broadcastState: 'broadcasted',
    });

    const { default: TransactionService } = await import(
      '../TransactionService'
    );
    const result = await TransactionService.sendTransaction(RAW_TX, [
      {
        tx_hash: 'new-input',
        tx_pos: 1,
        address: 'bchtest:qnew',
        value: 50_000,
      } as never,
    ]);

    expect(result.txid).toBe('new-txid');
    expect(sendTransactionMock).toHaveBeenCalledWith(RAW_TX);
  });

  it('keeps the send lock when the new transaction reuses a reserved input', async () => {
    listActiveMock.mockResolvedValue([
      {
        txid: 'old',
        spentOutpoints: [{ tx_hash: 'same-input', tx_pos: 2 }],
      },
    ]);

    const { default: TransactionService } = await import(
      '../TransactionService'
    );
    const result = await TransactionService.sendTransaction('00cc', [
      {
        tx_hash: 'same-input',
        tx_pos: 2,
        address: 'bchtest:qsame',
        value: 50_000,
      } as never,
    ]);

    expect(result.errorMessage).toContain('already using one of these UTXOs');
    expect(result.conflictingTxids).toEqual(['old']);
    expect(sendTransactionMock).not.toHaveBeenCalled();
  });

  it('does not let a deterministic rejected record block a retry', async () => {
    listActiveMock.mockResolvedValue([
      {
        txid: 'rejected',
        lastError: 'Broadcast rejected for insufficient fee.',
        spentOutpoints: [{ tx_hash: 'same-input', tx_pos: 2 }],
      },
    ]);
    sendTransactionMock.mockResolvedValue({
      txid: 'new-txid',
      errorMessage: null,
      broadcastState: 'broadcasted',
    });

    const { default: TransactionService } = await import(
      '../TransactionService'
    );
    const result = await TransactionService.sendTransaction(RAW_TX, [
      {
        tx_hash: 'same-input',
        tx_pos: 2,
        address: 'bchtest:qsame',
        value: 50_000,
      } as never,
    ]);

    expect(result.txid).toBe('new-txid');
    expect(sendTransactionMock).toHaveBeenCalledWith(RAW_TX);
  });

  it('releases only explicitly selected multisig locks in their wallet scope', async () => {
    listActiveMock.mockResolvedValue([
      { txid: 'old-multisig-tx', spentOutpoints: [] },
      { txid: 'keep-this-tx', spentOutpoints: [] },
    ]);

    const { releaseMultisigOutboundLocks } = await import(
      '../TransactionService'
    );
    const released = await releaseMultisigOutboundLocks(42, [
      'OLD-MULTISIG-TX',
    ]);

    expect(released).toEqual(['old-multisig-tx']);
    expect(removeMock).toHaveBeenCalledWith('old-multisig-tx', 42);
    expect(removeMock).not.toHaveBeenCalledWith('keep-this-tx', 42);
  });

  it('does not broadcast an input reserved by an in-flight Fusion round', async () => {
    reservedFusionOutpointsMock.mockReturnValue(new Set(['fusion-input:3']));

    const { default: TransactionService } = await import(
      '../TransactionService'
    );
    const result = await TransactionService.sendTransaction('00dd', [
      {
        tx_hash: 'fusion-input',
        tx_pos: 3,
        address: 'bchtest:qfusion',
        value: 50_000,
      } as never,
    ]);

    expect(result.errorMessage).toContain('Fusion round');
    expect(sendTransactionMock).not.toHaveBeenCalled();
  });

  it.each(['user', 'flipstarter-pledge', 'authhead', 'fusion-in-flight'])(
    'refuses a fresh %s hold even when caller input metadata omits it',
    async (reason) => {
      holdMocks.invoke.mockResolvedValue([heldCoin(reason)]);
      const { default: service } = await import('../TransactionService');
      for (const inputs of [
        undefined,
        [],
        [{ tx_hash: 'cd'.repeat(32), tx_pos: 0 } as never],
      ]) {
        const result = await service.sendTransaction(RAW_TX, inputs);
        expect(result.errorMessage).toContain('frozen or reserved');
      }
      const build = await service.buildTransaction([], null, '', [
        { tx_hash: INPUT_TXID.toUpperCase(), tx_pos: 0 } as never,
      ]);
      expect(build.errorMsg).toContain('frozen or reserved');
      expect(buildTransactionMock).not.toHaveBeenCalled();
      expect(sendTransactionMock).not.toHaveBeenCalled();
      expect(removeMock).not.toHaveBeenCalled();
    }
  );

  it('reads holds after the live outpoint check, catching a hold added after review', async () => {
    holdMocks.verify.mockImplementation(async () => {
      holdMocks.invoke.mockResolvedValue([heldCoin()]);
      return { ok: true };
    });
    const { default: service } = await import('../TransactionService');
    const result = await service.sendTransaction(RAW_TX, [
      { tx_hash: INPUT_TXID, tx_pos: 0 } as never,
    ]);
    expect(result.errorMessage).toContain('frozen or reserved');
    expect(sendTransactionMock).not.toHaveBeenCalled();
  });

  it('fails closed on unreadable Rust holds and never reaches signing or broadcast', async () => {
    holdMocks.invoke.mockRejectedValue('coin holds file is unreadable');
    const { default: service } = await import('../TransactionService');
    expect((await service.sendTransaction(RAW_TX)).errorMessage).toContain(
      'coin holds file is unreadable'
    );
    expect(
      (
        await service.buildTransaction([], null, '', [
          { tx_hash: INPUT_TXID, tx_pos: 0 } as never,
        ])
      ).errorMsg
    ).toContain('coin holds file is unreadable');
    expect(sendTransactionMock).not.toHaveBeenCalled();
    expect(buildTransactionMock).not.toHaveBeenCalled();
  });

  it.each(['currentWalletId', 'networkType', 'sessionGeneration'] as const)(
    'rejects %s changes while reading holds',
    async (field) => {
      holdMocks.invoke.mockImplementation(async () => {
        if (field === 'networkType')
          holdMocks.state.wallet_id.networkType = 'mainnet';
        else holdMocks.state.wallet_id[field] += 1;
        return [];
      });
      const { default: service } = await import('../TransactionService');
      expect((await service.sendTransaction(RAW_TX)).errorMessage).toContain(
        'Wallet or network changed'
      );
      expect(sendTransactionMock).not.toHaveBeenCalled();
    }
  );

  it('fails closed without a wallet or a decodable transaction', async () => {
    const { default: service } = await import('../TransactionService');
    expect((await service.sendTransaction('00aa')).errorMessage).toContain(
      'transaction'
    );
    holdMocks.state.wallet_id.currentWalletId = 0;
    expect((await service.sendTransaction(RAW_TX)).errorMessage).toBeTruthy();
    expect(sendTransactionMock).not.toHaveBeenCalled();
  });

  it('checks every batch item before broadcast and uses its explicit wallet scope', async () => {
    holdMocks.invoke.mockImplementation(async (_command, args) =>
      args.walletId === 42 ? [heldCoin()] : []
    );
    const { default: service } = await import('../TransactionService');
    const result = await service.sendTransactionBatch([
      { rawTX: RAW_TX },
      { rawTX: RAW_TX, options: { walletId: 42 } },
    ]);
    expect(result[0].errorMessage).toContain('frozen or reserved');
    expect(sendTransactionMock).not.toHaveBeenCalled();
  });

  it('rechecks holds between batch handoffs without clearing refused tracking', async () => {
    sendTransactionMock.mockImplementation(async () => {
      holdMocks.invoke.mockResolvedValue([heldCoin()]);
      return {
        txid: 'first',
        errorMessage: null,
        broadcastState: 'broadcasted',
      };
    });
    const { default: service } = await import('../TransactionService');
    const result = await service.sendTransactionBatch([
      { rawTX: RAW_TX },
      { rawTX: RAW_TX },
    ]);
    expect(result).toHaveLength(2);
    expect(result[1].errorMessage).toContain('frozen or reserved');
    expect(sendTransactionMock).toHaveBeenCalledTimes(1);
    expect(removeMock).not.toHaveBeenCalled();
  });

  it('preserves non-desktop build and single/batch sends without a hold IPC or inspector', async () => {
    holdMocks.desktop = false;
    holdMocks.invoke.mockRejectedValue('no desktop hold capability');
    const built = {
      bytecodeSize: 1,
      finalTransaction: '00aa',
      finalOutputs: [],
      errorMsg: '',
    };
    buildTransactionMock.mockResolvedValue(built);
    sendTransactionMock.mockResolvedValue({
      txid: 'mock-only',
      errorMessage: null,
    });
    const { default: service } = await import('../TransactionService');
    // Non-decodable fixture proves the new desktop inspector is not involved.
    expect(await service.buildTransaction([], null, '', [])).toEqual(built);
    expect((await service.sendTransaction('00aa')).txid).toBe('mock-only');
    expect(
      (await service.sendTransactionBatch([{ rawTX: '00bb' }]))[0].txid
    ).toBe('mock-only');
    expect(holdMocks.invoke).not.toHaveBeenCalled();
    expect(buildTransactionMock).toHaveBeenCalledTimes(1);
    expect(sendTransactionMock).toHaveBeenCalledTimes(2);
  });
});

describe('TransactionService.addOutput', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('initializes the transaction manager before adding an output', async () => {
    addOutputMock.mockReturnValue({
      recipientAddress: 'bitcoincash:qrecipient',
      amount: 1000,
    });

    const { default: TransactionService } = await import(
      '../TransactionService'
    );

    const result = TransactionService.addOutput(
      'bitcoincash:qrecipient',
      1000,
      0,
      '',
      [],
      []
    );

    expect(result).toEqual({
      recipientAddress: 'bitcoincash:qrecipient',
      amount: 1000,
    });
    expect(addOutputMock).toHaveBeenCalledWith(
      'bitcoincash:qrecipient',
      1000,
      0,
      '',
      [],
      [],
      undefined,
      undefined
    );
  });
});
