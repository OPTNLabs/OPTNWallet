// P2P CashFusion orchestration — Phase 4c. The peer-to-peer counterpart of
// FusionService.ts: instead of a central server, peers meet on Nostr, elect a
// coordinator, and run the (proven) fusion round over the Nostr transport.
//
// This is the glue that binds the wallet to the proven engine:
//   gatherInputs / allocateOutputs (shared with the server path) → a round
//   identity → pool announce + discovery (nostr/fusion) → freeze participants →
//   runFusionRound over the Nostr transport → broadcast via the wallet's Electrum
//   backend.
//
// The engine underneath (assembly, safety gate, signing, choreography) is proven
// offline; this orchestration needs a live chipnet round with real peers to
// calibrate — notably the fee/output allocation, which currently reuses the
// server allocator and leans on the round safety gate (verifyFusionSafety) as the
// backstop that refuses to sign an over/under-paid transaction. It stays gated to
// the chipnet execution path (isFusionExecutionAllowed); mainnet remains blocked.

import { SimplePool } from 'nostr-tools';
import { hexToBin } from '../../utils/hex';
import ElectrumService from '../../services/ElectrumService';
import { Network } from '../../state/slices/networkSlice';
import type { UTXO } from '../../types/types';
import { gatherInputs, allocateOutputs, chooseTier, type FusionServerParams } from './FusionService';
import { isFusionExecutionAllowed } from './FusionExecutionSafety';
import { generateRoundIdentity, joinPool, type PoolAnnouncement } from './nostr/fusion';
import { createNostrRoundTransport } from './nostr/fusionTransport';
import { runFusionRound, type RoundResult } from './nostr/fusionSession';
import type { FusionInputRef, FusionOutputRef } from './nostr/fusionRound';
import { DEFAULT_RELAYS } from './nostr/chat';

/** Every peer must agree on the feerate so the assembled tx's fee is identical. */
const P2P_FEERATE = 1000; // 1 sat/byte
const P2P_TIERS = [10_000, 100_000, 1_000_000, 10_000_000];
// maxExcessFee is intentionally loose: the round's verifyFusionSafety gate (fee
// within [min, 3×min]) is the real economic guard, so allocation never blocks a
// round the gate would accept. ponytail: a change-output allocator that keeps the
// leftover minimal is the calibration upgrade once live rounds confirm the math.
const P2P_PARAMS: FusionServerParams = {
  tiers: P2P_TIERS,
  numComponents: 100,
  componentFeerate: P2P_FEERATE,
  minExcessFee: 0,
  maxExcessFee: 20_000_000,
};

const MIN_PARTICIPANTS = 2;
// A fixed collection window: every peer announces immediately (below) and freezes
// its participant set when the window closes, so wallets whose Fuse Now is pressed
// within the window all freeze the SAME set — the coordinator and participants
// then agree without a separate round_start negotiation. Clicks must fall inside
// this window. ponytail: a coordinator-anchored round_start removes the timing
// constraint entirely; add it when rounds run beyond a controlled test.
const POOL_WINDOW_MS = 60_000;

export interface P2pFusionOptions {
  walletId: number;
  network: Network;
  utxos: UTXO[];
  relays?: string[];
  onStatus?: (msg: string) => void;
}

/** Collect announcements for a fixed window, then freeze the participant set. */
function waitForParticipants(
  myPubkey: string,
  getPeers: () => PoolAnnouncement[],
  onStatus?: (m: string) => void
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + POOL_WINDOW_MS;
    const tick = () => {
      const set = new Set([myPubkey, ...getPeers().map((p) => p.pubkey)]);
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      onStatus?.(`Peers in pool: ${set.size} (collecting ${left}s)`);
      console.info('[p2p-fusion] pool size', set.size, 'window', left, 's');
      if (Date.now() >= deadline) {
        if (set.size >= MIN_PARTICIPANTS) return resolve([...set].sort());
        return reject(new Error(`No fusion pool formed for this tier (need ${MIN_PARTICIPANTS}, saw ${set.size}).`));
      }
      setTimeout(tick, 2000);
    };
    tick();
  });
}

/**
 * Run one P2P fusion round for the wallet's non-token UTXOs. Chipnet-only for
 * now (mainnet stays gated). Resolves with the broadcast txid.
 */
export async function runP2pFusion(opts: P2pFusionOptions): Promise<RoundResult> {
  if (!isFusionExecutionAllowed(opts.network)) {
    throw new Error('P2P fusion execution is paused on this network.');
  }
  const relays = opts.relays?.length ? opts.relays : DEFAULT_RELAYS;
  const status = opts.onStatus;

  // 1. Gather my inputs (with signing keys) and allocate fresh-HD tier outputs.
  const runInputs = await gatherInputs(opts.walletId, opts.utxos);
  const sumIn = runInputs.reduce((s, i) => s + i.value, 0);
  const tier = chooseTier(sumIn, P2P_PARAMS);
  if (tier == null) throw new Error('Inputs too small for any P2P fusion tier.');
  status?.(`Chosen tier: ${tier} sats`);
  const alloc = await allocateOutputs(opts.walletId, opts.network, tier, runInputs, P2P_PARAMS);

  const myInputs: FusionInputRef[] = runInputs.map((i) => ({
    prevTxid: i.prev_txid,
    prevIndex: i.prev_index,
    value: i.value,
    pubkey: i.pubkey,
  }));
  const keysByPubkey = new Map(runInputs.map((i) => [i.pubkey, hexToBin(i.privkey)]));
  const myOutputs: FusionOutputRef[] = alloc.scripts.map((script, n) => ({ script, value: alloc.values[n] }));

  // 2. Announce readiness on the tier pool and discover peers.
  const round = generateRoundIdentity();
  const pool = new SimplePool();
  let peers: PoolAnnouncement[] = [];
  const jp = joinPool(pool, relays, round, tier, myInputs.length, myOutputs.length, (p) => {
    peers = p;
  });
  jp.announceNow(); // announce immediately so the pool forms quickly for the test
  console.info('[p2p-fusion] announced tier', tier, 'round pubkey', round.pubkey.slice(0, 8), 'relays', relays);
  status?.('Announced to the tier pool; waiting for peers…');

  try {
    // 3. Freeze the participant set once the pool forms.
    const participants = await waitForParticipants(round.pubkey, () => peers, status);
    status?.(`Pool formed with ${participants.length} peers; running round…`);

    // 4. Run the proven round over the Nostr transport; coordinator broadcasts.
    const transport = createNostrRoundTransport(pool, relays, round);
    const result = await runFusionRound(
      {
        myPubkey: round.pubkey,
        participants,
        tier,
        feerate: P2P_FEERATE,
        myContribution: { inputs: myInputs, outputs: myOutputs },
        keysByPubkey,
        broadcast: (txHex) => ElectrumService.broadcastTransaction(txHex),
      },
      transport
    );
    status?.(`Fused ✓ — txid ${result.txid}`);
    return result;
  } finally {
    jp.stop();
    pool.close(relays);
  }
}
