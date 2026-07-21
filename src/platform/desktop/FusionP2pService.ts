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
// runs on all networks (isFusionExecutionAllowed → true, owner opt-in), with the
// per-round verifyFusionSafety gate + mandatory Tor as the runtime fund safety.

import { SimplePool } from 'nostr-tools';
// aliased: the `use*` name trips the react-hooks lint rule, but this is not a hook.
import { useWebSocketImplementation as setNostrWebSocketImpl } from 'nostr-tools/pool';
import { invoke } from '@tauri-apps/api/core';
import { hexToBin } from '../../utils/hex';
import { TorWebSocket, armTorRouting, disarmTorRouting } from './nostr/torWebSocket';
import ElectrumService from '../../services/ElectrumService';
import { Network } from '../../state/slices/networkSlice';
import type { UTXO } from '../../types/types';
import { gatherInputs, allocateOutputs, type FusionServerParams } from './FusionService';
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

/** Whether the Tor WebSocket shim has been installed into nostr-tools yet. */
let wsInstalled = false;

const MIN_PARTICIPANTS = 2;
// A fixed collection window: every peer announces immediately (below) and freezes
// its participant set when the window closes, so wallets whose Fuse Now is pressed
// within the window all freeze the SAME set — the coordinator and participants
// then agree without a separate round_start negotiation. Clicks must fall inside
// this window. ponytail: a coordinator-anchored round_start removes the timing
// constraint entirely; add it when rounds run beyond a controlled test.
const POOL_WINDOW_MS = 60_000;

/** Live round phases shown as a 1–5 stepper (00-Wallet style). Index 0 = idle. */
export const P2P_PHASE_LABELS = [
  'Idle',
  'Announcing & finding peers',
  'Registering inputs & outputs',
  'Assembling & verifying',
  'Signing',
  'Broadcasting',
] as const;

export interface P2pFusionOptions {
  walletId: number;
  network: Network;
  utxos: UTXO[];
  relays?: string[];
  /** Tor SOCKS proxy to route relay traffic through. REQUIRED — P2P fusion fails
   *  closed without Tor, like classic CashFusion. */
  tor: { host: string; port: number } | null;
  onStatus?: (msg: string) => void;
  /** Live phase 1–5 for the UI stepper (see P2P_PHASE_LABELS). */
  onPhase?: (phase: number) => void;
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
 * Run one P2P fusion round for the wallet's non-token UTXOs on any network.
 * Resolves with the broadcast txid.
 */
export async function runP2pFusion(opts: P2pFusionOptions): Promise<RoundResult> {
  if (!isFusionExecutionAllowed()) {
    throw new Error('P2P fusion execution is paused.');
  }
  // Fail closed on Tor: P2P fusion must not touch a relay without Tor, so a peer's
  // IP can't be correlated across its (round-key) inputs and (throwaway-key)
  // outputs. Same requirement as classic CashFusion.
  if (!opts.tor) {
    throw new Error('Tor is required for P2P fusion — enable Tor in settings and wait for it to bootstrap.');
  }
  const torOk = await invoke<boolean>('fusion_tor_check', { host: opts.tor.host, port: opts.tor.port });
  if (!torOk) {
    throw new Error('Tor is not reachable — P2P fusion will not run without Tor.');
  }
  const relays = opts.relays?.length ? opts.relays : DEFAULT_RELAYS;
  const status = opts.onStatus;

  // Route every relay socket for this round through the Rust Tor->WSS bridge.
  // Installed process-wide (idempotent) but only ACTIVE while armed, so chat's
  // relays stay on native WebSockets.
  if (!wsInstalled) {
    setNostrWebSocketImpl(TorWebSocket);
    wsInstalled = true;
  }
  armTorRouting({ host: opts.tor.host, port: opts.tor.port });
  status?.('Tor verified; routing relay traffic over Tor.');

  // 1. Gather my inputs (with signing keys) and allocate fresh-HD tier outputs.
  const runInputs = await gatherInputs(opts.walletId, opts.utxos);
  const sumIn = runInputs.reduce((s, i) => s + i.value, 0);
  // Pick the LARGEST affordable tier: k·tier then covers most of the balance so the
  // leftover (excess) stays under one tier and within the fee bound. The smallest
  // tier would leave a huge unallocatable excess for a large balance (the "excess
  // not in [0, …]" error). Reserve ~1 tier for fees + change headroom.
  const tier =
    [...P2P_TIERS].sort((a, b) => b - a).find((t) => sumIn >= t * 2) ??
    [...P2P_TIERS].sort((a, b) => b - a).find((t) => sumIn > t) ??
    null;
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
  opts.onPhase?.(1); // announcing & finding peers
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
        onPhase: opts.onPhase,
      },
      transport
    );
    status?.(`Fused ✓ — txid ${result.txid}`);
    return result;
  } finally {
    jp.stop();
    pool.close(relays);
    disarmTorRouting(); // chat relays revert to native WebSockets
  }
}
