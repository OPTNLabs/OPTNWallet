// F1 regression lock — an ambiguous P2P broadcast must not be finalized as
// success, and must not hand its inputs back to the next round.
//
// `broadcastP2pTransactionTorOnly` returns `{verified:false, warning:'…remains
// reserved while wallet sync verifies it'}` when neither the Tor relay
// observation nor the Tor-routed `fusion_transaction_is_known` lookup can
// confirm visibility. The original bug was that `runP2pFusion` discarded
// `receipt.verified`: it printed `Fused ✓` and its `finally` released the input
// reservations unconditionally, contradicting the receipt's own promise and
// letting the next round build a conflicting spend against a CoinJoin that may
// already be confirming.
//
// Three outcomes, not two — all three are asserted here:
//   never reached the relay  → release (a failed round must not strand coins)
//   reached relay, verified  → release (the coins are spent)
//   reached relay, unresolved→ HOLD    (fate unknown; the receipt promised this)

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { hash256 } from '@bitauth/libauth';
import { binToHex, hexToBin } from '../../../utils/hex';
import type { UTXO } from '../../../types/types';
import { Network } from '../../../state/slices/networkSlice';

const invokeMock = vi.fn();
const releaseOutpointsMock = vi.fn();
const reserveOutpointsMock = vi.fn();
const reservedOutpointsMock = vi.fn();
const runFusionRoundMock = vi.fn();
const trackAttemptMock = vi.fn();
const markVerificationPendingMock = vi.fn(async () => ({}));
const removeTrackedMock = vi.fn(async () => undefined);
const completeFusionBroadcastMock = vi.fn(async () => ({}));

/** Signed CoinJoin bytes the mocked round hands to `broadcast`. */
const TX_HEX = '02000000000101' + '00'.repeat(32) + '00000000';
const EXPECTED_TXID = binToHex(hash256(hexToBin(TX_HEX)).reverse());

const SELF_KEY = 'a'.repeat(64);
const PEER_KEYS = ['b'.repeat(64), 'c'.repeat(64)];

const COIN: UTXO = {
  address: 'bchtest:qfuse',
  height: 100,
  tx_hash: 'd'.repeat(64),
  tx_pos: 0,
  value: 5_000_000,
};
const COIN_OUTPOINT = `${COIN.tx_hash}:${COIN.tx_pos}`;

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

vi.mock('nostr-tools', () => ({
  SimplePool: class {
    close = vi.fn();
  },
}));
vi.mock('nostr-tools/pool', () => ({
  useWebSocketImplementation: vi.fn(),
}));

vi.mock('../nostr/torWebSocket', () => ({
  TorWebSocket: class {},
  armTorRouting: vi.fn(() => vi.fn()),
}));

vi.mock('../../../services/ElectrumService', () => ({
  default: {
    getUTXOsMany: vi.fn(),
    broadcastTransaction: vi.fn(),
    getTransactionVisibility: vi.fn(),
  },
  invalidateUTXOCache: vi.fn(),
}));

vi.mock('../../../services/WalletUtxoRefreshService', () => ({
  reconcileActiveWalletUtxosForSpend: vi.fn(),
}));

vi.mock('../../../services/OutboundTransactionTracker', () => ({
  default: {
    trackAttempt: trackAttemptMock,
    markVerificationPending: markVerificationPendingMock,
    remove: removeTrackedMock,
  },
}));

vi.mock('../fusionRoundState', () => ({
  clearOutpointReservations: vi.fn(),
  isBlamedSessionKey: vi.fn(() => false),
  isOwnRoundKey: vi.fn(() => false),
  isRetiredRoundKey: vi.fn(() => false),
  outpointKey: vi.fn((txHash: string, txPos: number) => `${txHash}:${txPos}`),
  recordBlamedSessionKey: vi.fn(),
  recordRoundKey: vi.fn(),
  releaseOutpoints: releaseOutpointsMock,
  reserveOutpoints: reserveOutpointsMock,
  reservedOutpoints: reservedOutpointsMock,
  retireAllOwnRoundKeys: vi.fn(),
  retireRoundKey: vi.fn(),
}));

vi.mock('../FusionCompletionService', () => ({
  completeFusionBroadcast: completeFusionBroadcastMock,
  fusionCompletionWarning: vi.fn(() => undefined),
}));

vi.mock('../FusionService', () => ({
  createFreshFusionOutputScripts: vi.fn(async () => [
    `76a914${'00'.repeat(20)}88ac`,
    `76a914${'11'.repeat(20)}88ac`,
  ]),
  gatherInputs: vi.fn(async () => [
    {
      prev_txid: COIN.tx_hash,
      prev_index: COIN.tx_pos,
      value: COIN.value,
      pubkey: `02${'22'.repeat(32)}`,
      privkey: '33'.repeat(32),
    },
  ]),
}));

vi.mock('../FusionExecutionSafety', () => ({
  isFusionExecutionAllowed: vi.fn(() => true),
}));

vi.mock('../ServerFusionRunner', () => ({
  defaultRelayEndpoints: vi.fn(() => ({
    relayHost: 'relay',
    relayPort: 50002,
  })),
  inputLookupEndpoints: vi.fn(() => [
    { host: 'lookup', port: 50002, useSsl: true },
  ]),
}));

vi.mock('../nostr/fusion', () => ({
  MIN_PARTICIPANTS: 3,
  MAX_PARTICIPANTS: 3,
  POOL_PEER_TTL_SECONDS: 300,
  generateRoundIdentity: vi.fn(() => ({
    pubkey: SELF_KEY,
    secretKey: new Uint8Array(32).fill(7),
  })),
  invalidateJoinPoolAnnouncers: vi.fn(),
  isLivePoolAnnouncement: vi.fn(() => true),
  poolEpoch: vi.fn(() => 1),
  // The gather loop reads whatever `onPeer` last stored, so hand it a full,
  // stable set immediately — this test is about the broadcast tail, not gather.
  joinPool: vi.fn(
    (
      _pool: unknown,
      _relays: string[],
      params: {
        round: { pubkey: string };
        network: string;
        epoch: number;
        tiers: number[];
        numInputs: number;
        onPeer: (peers: unknown[]) => void;
      }
    ) => {
      const now = Math.floor(Date.now() / 1_000);
      const announce = (pubkey: string) => ({
        pubkey,
        network: params.network,
        epoch: params.epoch,
        tiers: params.tiers,
        numInputs: params.numInputs,
        at: now,
        seenAt: now,
        expiresAt: now + 300,
      });
      params.onPeer([
        announce(params.round.pubkey),
        ...PEER_KEYS.map(announce),
      ]);
      return {
        stop: vi.fn(),
        withdraw: vi.fn(async () => undefined),
        announceNow: vi.fn(async () => undefined),
      };
    }
  ),
  selectFusionGroup: vi.fn((peers: Array<{ pubkey: string }>) => ({
    participants: peers.map((peer) => peer.pubkey),
    tier: 1_000_000,
  })),
}));

vi.mock('../nostr/fusionTransport', () => ({
  createNostrRoundTransport: vi.fn(() => ({
    onMessage: vi.fn(() => vi.fn()),
    send: vi.fn(async () => undefined),
    close: vi.fn(),
  })),
}));

vi.mock('../nostr/fusionRendezvous', () => ({
  negotiateFusionRound: vi.fn(
    async (params: { candidates: string[]; tier: number }) => ({
      participants: [...params.candidates],
      session: 'test-session',
      tier: params.tier,
    })
  ),
}));

vi.mock('../nostr/fusionSession', () => ({
  runFusionRound: runFusionRoundMock,
}));

vi.mock('../nostr/fusionBlindSchnorr', () => ({
  MAX_INPUT_CREDENTIALS_PER_PEER: 8,
}));

vi.mock('../nostr/fusionRound', () => ({
  minimumFee: vi.fn(() => 1_000),
}));

vi.mock('../nostr/fusionSign', () => ({
  toLibauthTx: vi.fn(),
}));

vi.mock('../nostr/fusionP2pAllocation', () => ({
  planP2pOutputValues: vi.fn(() => ({ values: [2_000_000, 2_000_000] })),
}));

// Collapse every gather budget so the peer loop locks on its first pass.
vi.mock('../fusionTiming', () => ({
  P2P_COMPONENT_JITTER_MS: 0,
  P2P_GATHER_ALONE_AUTO_MS: 2_000,
  P2P_GATHER_ALONE_MS: 2_000,
  P2P_GATHER_FAST_WARMUP_MS: 0,
  P2P_GATHER_MAX_MS: 2_000,
  P2P_GATHER_MIN_MS: 0,
  P2P_PEAK_GRACE_MS: 0,
  P2P_PEER_SET_STABLE_FAST_MS: 0,
  P2P_PEER_SET_STABLE_MS: 0,
  P2P_PROPOSAL_TIMEOUT_MS: 1_000,
  P2P_RENDEZVOUS_MS: 1_000,
  P2P_ROUND_TIMEOUT_MS: 2_000,
  P2P_SMALL_SET_HOLD_MS: 0,
}));

vi.mock('../logger', () => ({
  log: {
    info: vi.fn(async () => undefined),
    warn: vi.fn(async () => undefined),
    error: vi.fn(async () => undefined),
  },
}));

/**
 * @param relayVisible whether the Tor relay observed the CoinJoin
 * @param lookupVisible whether the independent Tor-routed lookup saw it
 */
function armBroadcast(relayVisible: boolean, lookupVisible: boolean): void {
  invokeMock.mockImplementation(async (command: string) => {
    if (command === 'fusion_tor_check') return true;
    if (command === 'fusion_relay_broadcast_and_observe') {
      return {
        txid: EXPECTED_TXID,
        relaySubmitted: true,
        observerSeen: relayVisible,
      };
    }
    if (command === 'fusion_transaction_is_known') return lookupVisible;
    return undefined;
  });
}

async function runRound(): Promise<{
  statuses: string[];
  error: Error | null;
}> {
  const statuses: string[] = [];
  const { runP2pFusion } = await import('../FusionP2pService');
  let error: Error | null = null;
  try {
    await runP2pFusion({
      walletId: 1,
      network: Network.CHIPNET,
      utxos: [COIN],
      tor: { host: '127.0.0.1', port: 9050 },
      trigger: 'manual',
      onStatus: (message) => statuses.push(message),
    });
  } catch (caught) {
    error = caught instanceof Error ? caught : new Error(String(caught));
  }
  return { statuses, error };
}

describe('F1 — unresolved P2P broadcast keeps its input reservations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reservedOutpointsMock.mockReturnValue(new Set<string>());
    trackAttemptMock.mockResolvedValue({ txid: EXPECTED_TXID });
    runFusionRoundMock.mockImplementation(
      async (params: { broadcast: (txHex: string) => Promise<string> }) => ({
        txid: await params.broadcast(TX_HEX),
        txHex: TX_HEX,
      })
    );
  });

  it('releases reservations and reports success when relay accepted (even if observer is slow)', async () => {
    armBroadcast(false, false);

    const { statuses, error } = await runRound();

    expect(error).toBeNull();
    // On BCH, 0-conf means relay acceptance IS confirmation.
    expect(releaseOutpointsMock).toHaveBeenCalledWith(1, [COIN_OUTPOINT]);
    expect(statuses.some((line) => line.includes('Fused ✓'))).toBe(true);
    expect(statuses.some((line) => line.startsWith('Fusion pending —'))).toBe(
      false
    );
  });

  it('releases the reservations and reports success once the CoinJoin is independently seen', async () => {
    armBroadcast(true, true);

    const { statuses, error } = await runRound();

    expect(error).toBeNull();
    expect(releaseOutpointsMock).toHaveBeenCalledWith(1, [COIN_OUTPOINT]);
    expect(statuses.some((line) => line.includes('Fused ✓'))).toBe(true);
    expect(statuses.some((line) => line.startsWith('Fusion pending —'))).toBe(
      false
    );
  });

  it('releases the reservations when the round never reached the relay', async () => {
    armBroadcast(false, false);
    runFusionRoundMock.mockRejectedValue(new Error('round aborted'));

    const { error } = await runRound();

    // A round that died before broadcast must not strand the coins until TTL.
    expect(error?.message).toBe('round aborted');
    expect(releaseOutpointsMock).toHaveBeenCalledWith(1, [COIN_OUTPOINT]);
  });

  it('removes tracking and releases inputs after a definite node rejection', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'fusion_tor_check') return true;
      if (command === 'fusion_relay_broadcast_and_observe') {
        throw new Error('mempool min fee not met, 219 < 233 (code 66)');
      }
      if (command === 'fusion_transaction_is_known') return false;
      return undefined;
    });

    const { error } = await runRound();

    expect(error?.message).toContain('Fusion broadcast rejected');
    expect(completeFusionBroadcastMock).not.toHaveBeenCalled();
    expect(removeTrackedMock).toHaveBeenCalledWith(EXPECTED_TXID, 1);
    expect(releaseOutpointsMock).toHaveBeenCalledWith(1, [COIN_OUTPOINT]);
  });

  it('resolves via relay acceptance without needing a Tor-routed lookup', async () => {
    armBroadcast(false, true);

    const { statuses, error } = await runRound();

    expect(error).toBeNull();
    const commands = invokeMock.mock.calls.map((call) => call[0] as string);
    // relaySubmitted is enough on BCH 0-conf — no lookup needed
    expect(commands).not.toContain('fusion_transaction_is_known');
    expect(releaseOutpointsMock).toHaveBeenCalledWith(1, [COIN_OUTPOINT]);
    expect(statuses.some((line) => line.includes('Fused ✓'))).toBe(true);
  });
});
