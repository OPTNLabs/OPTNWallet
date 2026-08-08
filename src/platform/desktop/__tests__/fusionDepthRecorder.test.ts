import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  encodeTransaction,
  cashAddressToLockingBytecode,
  hexToBin,
  binToHex,
} from '@bitauth/libauth';

import { ownedOutpointsOf, spentOutpointsOf } from '../fusionDepthRecorder';
import { clearFusionDepth, coinDepth } from '../fusionCoinDepth';

// Keep the completion layer's other collaborators inert: this suite is about
// depth accounting, not tracking/observation/refresh (which Codex owns).
const recordBroadcast = vi.fn();
const reconcileActiveWalletUtxosForSpend = vi.fn();
const { completionDb, completionDispatch } = vi.hoisted(() => ({
  completionDb: {
    run: vi.fn(),
    prepare: vi.fn(() => ({
      step: () => false,
      free: vi.fn(),
    })),
  },
  completionDispatch: vi.fn(),
}));
vi.mock('../../../services/OutboundTransactionTracker', () => ({
  default: {
    recordBroadcast: (...a: unknown[]) => recordBroadcast(...a),
    markState: vi.fn().mockResolvedValue({ state: 'seen' }),
  },
}));
vi.mock('../../../services/WalletBackendSyncService', () => ({
  default: { observeTransaction: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../../../services/WalletUtxoRefreshService', () => ({
  reconcileActiveWalletUtxosForSpend: (...a: unknown[]) =>
    reconcileActiveWalletUtxosForSpend(...a),
}));
vi.mock('../../../apis/DatabaseManager/DatabaseService', () => ({
  default: () => ({
    ensureDatabaseStarted: vi.fn().mockResolvedValue(undefined),
    getDatabase: () => completionDb,
    saveDatabaseToFile: vi.fn().mockResolvedValue(undefined),
    scheduleDatabaseSave: vi.fn(),
  }),
}));
vi.mock('../../../state/store', () => ({
  store: { dispatch: completionDispatch },
}));
vi.mock('../../../state/slices/transactionSlice', () => ({
  addTransactions: (payload: unknown) => ({
    type: 'transactions/addTransactions',
    payload,
  }),
}));

import { completeFusionBroadcast } from '../FusionCompletionService';

const OURS_A = 'bchtest:qpglfz6m98dq2fxcf48xamft4ga0hsmwmqc2mn26nt';
const OURS_B = 'bchtest:qprxy5zummllf2yx2626cp3jyzyqexzk5veu6ham8k';
const PEER = 'bchtest:qptv7uwypklpfcy856jzgzr6kenwlg9wesgyavzcmj';
const TXID = 'ab'.repeat(32);

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(k: string) {
    return this.map.has(k) ? (this.map.get(k) as string) : null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  clear() {
    this.map.clear();
  }
}

function scriptHex(address: string): string {
  const decoded = cashAddressToLockingBytecode(address);
  if (typeof decoded === 'string') throw new Error(decoded);
  return binToHex(decoded.bytecode);
}

/** Outputs deliberately interleaved: ours is NOT at a predictable index. */
function coinJoinHex(addresses: string[]): string {
  return binToHex(
    encodeTransaction({
      version: 2,
      locktime: 0,
      inputs: [
        {
          outpointTransactionHash: hexToBin('11'.repeat(32)),
          outpointIndex: 0,
          sequenceNumber: 0xffffffff,
          unlockingBytecode: Uint8Array.of(),
        },
      ],
      outputs: addresses.map((address) => ({
        lockingBytecode: hexToBin(scriptHex(address)),
        valueSatoshis: 50_000n,
      })),
    })
  );
}

const utxo = (txid: string, pos = 0) =>
  ({ tx_hash: txid, tx_pos: pos }) as never;

describe('fusion depth: ownership matching', () => {
  it('matches by locking script, not output position', () => {
    // Peer, ours, peer, ours — a shuffled round. Index-based logic would fail.
    const hex = coinJoinHex([PEER, OURS_A, PEER, OURS_B]);
    expect(
      ownedOutpointsOf(hex, TXID, [scriptHex(OURS_A), scriptHex(OURS_B)])
    ).toEqual([`${TXID}:1`, `${TXID}:3`]);
  });

  it('claims nothing when no output pays us', () => {
    const hex = coinJoinHex([PEER, PEER]);
    expect(ownedOutpointsOf(hex, TXID, [scriptHex(OURS_A)])).toEqual([]);
  });

  it('claims nothing when the caller supplies no scripts', () => {
    const hex = coinJoinHex([OURS_A]);
    expect(ownedOutpointsOf(hex, TXID, [])).toEqual([]);
  });

  it('survives an undecodable transaction without throwing', () => {
    expect(
      ownedOutpointsOf('not-hex-at-all', TXID, [scriptHex(OURS_A)])
    ).toEqual([]);
  });

  it('maps spent inputs to outpoints', () => {
    expect(spentOutpointsOf([utxo('aa', 1), utxo('bb', 0)])).toEqual([
      'aa:1',
      'bb:0',
    ]);
  });
});

describe('fusion depth: one shared completion path for both transports', () => {
  beforeEach(() => {
    (globalThis as { localStorage?: unknown }).localStorage =
      new MemoryStorage();
    clearFusionDepth(9);
    recordBroadcast.mockReset().mockResolvedValue(undefined);
    reconcileActiveWalletUtxosForSpend
      .mockReset()
      .mockResolvedValue({ addr: [] });
  });

  it.each([
    ['p2p-fusion', 'P2P Fusion'],
    ['server-fusion', 'CashFusion server'],
  ] as const)('records depth identically for %s', async (source, label) => {
    const result = await completeFusionBroadcast({
      walletId: 9,
      txid: TXID,
      txHex: coinJoinHex([PEER, OURS_A]),
      spentInputs: [utxo('prev', 0)],
      source,
      sourceLabel: label,
      ownedOutputScripts: [scriptHex(OURS_A)],
    });

    expect(result.depthRecorded).toBe(1);
    expect(coinDepth(9, `${TXID}:1`)).toBe(1);
    // Per-txid depth: the CoinJoin txid is marked depth 1 so index remap cannot
    // reset the chain. We only query our own UTXOs; peer index 0 is not written
    // as its own outpoint entry, but shares the txid depth if asked.
    expect(coinDepth(9, `${TXID}:0`)).toBe(1);
    // The consumed input is dropped, so the map tracks live coins.
    expect(coinDepth(9, 'prev:0')).toBe(0);
  });

  it('without owned scripts still stamps CoinJoin for Fused labels (no outpoint map)', async () => {
    const result = await completeFusionBroadcast({
      walletId: 9,
      txid: TXID,
      txHex: coinJoinHex([PEER, OURS_A]),
      spentInputs: [utxo('prev', 0)],
      source: 'p2p-fusion',
      sourceLabel: 'P2P Fusion',
      privacyRoute: 'tor-only',
    });
    // No per-output scripts → no precise outpoint count, but the CoinJoin
    // txid is recorded so badges / Auto see ≥1 via parent-txid depth.
    expect(result.depthRecorded).toBe(0);
    expect(coinDepth(9, `${TXID}:1`)).toBeGreaterThanOrEqual(1);
  });

  it('still tracks and refreshes when depth accounting finds nothing', async () => {
    const result = await completeFusionBroadcast({
      walletId: 9,
      txid: TXID,
      txHex: coinJoinHex([PEER]),
      spentInputs: [utxo('prev', 0)],
      source: 'server-fusion',
      sourceLabel: 'CashFusion server',
      ownedOutputScripts: [scriptHex(OURS_A)],
    });
    // Depth is bookkeeping; the broadcast already happened and the wallet's own
    // tracking must not be held hostage to it.
    expect(result.depthRecorded).toBe(0);
    expect(result.tracked).toBe(true);
    expect(result.refreshed).toBe(true);
    expect(recordBroadcast).toHaveBeenCalledOnce();
  });
});
