// P2P CashFusion orchestration over Nostr + Tor.
//
// A fresh 00-Wallet-style identity announces compatible tiers in a short,
// network-scoped epoch. The elected coordinator then proposes one exact peer
// set; every peer acknowledges before a random-session round_start is issued.
// No input/output registration starts from an independently frozen local view.

import { SimplePool } from 'nostr-tools';
import { useWebSocketImplementation as setNostrWebSocketImpl } from 'nostr-tools/pool';
import { invoke } from '@tauri-apps/api/core';

import { hexToBin } from '../../utils/hex';
import { TorWebSocket, armTorRouting, disarmTorRouting } from './nostr/torWebSocket';
import ElectrumService from '../../services/ElectrumService';
import { Network } from '../../state/slices/networkSlice';
import type { UTXO } from '../../types/types';
import { createFreshFusionOutputScripts, gatherInputs } from './FusionService';
import { isFusionExecutionAllowed } from './FusionExecutionSafety';
import {
  generateRoundIdentity,
  joinPool,
  poolEpoch,
  poolEpochEnd,
  poolEpochStart,
  selectFusionGroup,
  POOL_EPOCH_GRACE_SECONDS,
  type FusionPoolNetwork,
  type PoolAnnouncement,
  type RoundIdentity,
} from './nostr/fusion';
import { createNostrRoundTransport } from './nostr/fusionTransport';
import { negotiateFusionRound } from './nostr/fusionRendezvous';
import { runFusionRound, type RoundResult } from './nostr/fusionSession';
import type { FusionInputRef, FusionOutputRef } from './nostr/fusionRound';
import { planP2pOutputValues } from './nostr/fusionP2pAllocation';
import { DEFAULT_RELAYS } from './nostr/chat';

const P2P_FEERATE = 1_000; // sats per 1000 bytes
const P2P_TIERS = [10_000, 100_000, 1_000_000, 10_000_000];
const MIN_PARTICIPANTS = 2;
const MAX_PARTICIPANTS = 10;
const EPOCH_SETTLE_SECONDS = 2;
const MAX_RELAYS = 8;
let wsInstalled = false;

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
  tor: { host: string; port: number } | null;
  onStatus?: (message: string) => void;
  onPhase?: (phase: number) => void;
  signal?: AbortSignal;
}

function toPoolNetwork(network: Network): FusionPoolNetwork {
  return network === Network.MAINNET ? 'mainnet' : 'chipnet';
}

function validatedRelays(configured?: string[]): string[] {
  const relays = Array.from(new Set((configured?.length ? configured : DEFAULT_RELAYS)))
    .filter((relay) => relay.startsWith('wss://'))
    .slice(0, MAX_RELAYS);
  if (relays.length === 0) throw new Error('No secure Nostr relays configured.');
  return relays;
}

function waitUntil(timestampMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error('fusion round cancelled'));
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener('abort', cancel);
      resolve();
    };
    const timer = setTimeout(finish, Math.max(0, timestampMs - Date.now()));
    const cancel = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      reject(new Error('fusion round cancelled'));
    };
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

async function collectEpoch(
  epoch: number,
  getPeers: () => PoolAnnouncement[],
  onStatus?: (message: string) => void,
  signal?: AbortSignal
): Promise<PoolAnnouncement[]> {
  const deadline = (poolEpochEnd(epoch) + EPOCH_SETTLE_SECONDS) * 1_000;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('fusion round cancelled');
    const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1_000));
    onStatus?.(`Fresh peers: ${getPeers().length} (epoch closes in ${left}s)`);
    await waitUntil(Math.min(deadline, Date.now() + 1_000), signal);
  }
  const now = Math.floor(Date.now() / 1_000);
  return getPeers().filter(
    (peer) => peer.epoch === epoch && peer.expiresAt >= now
  );
}

function assertBroadcastTxid(value: string): string {
  if (!/^[0-9a-f]{64}$/i.test(value)) {
    throw new Error(`Fusion broadcast failed: ${value}`);
  }
  return value.toLowerCase();
}

/** Run one P2P round on the active BCH network. */
export async function runP2pFusion(opts: P2pFusionOptions): Promise<RoundResult> {
  if (!isFusionExecutionAllowed()) throw new Error('P2P fusion execution is paused.');
  if (!opts.tor) {
    throw new Error('Tor is required for P2P fusion — enable Tor and wait for bootstrap.');
  }
  if (opts.signal?.aborted) throw new Error('fusion round cancelled');

  const torOk = await invoke<boolean>('fusion_tor_check', {
    host: opts.tor.host,
    port: opts.tor.port,
  });
  if (!torOk) throw new Error('Tor is not reachable — P2P fusion stopped.');

  const relays = validatedRelays(opts.relays);
  if (!wsInstalled) {
    setNostrWebSocketImpl(TorWebSocket);
    wsInstalled = true;
  }
  armTorRouting({ host: opts.tor.host, port: opts.tor.port });

  const pool = new SimplePool();
  // Output registrations get different relay sockets and Tor isolation streams.
  const outputPool = new SimplePool();
  let stopPool: (() => void) | null = null;
  let round: RoundIdentity | null = null;
  const status = opts.onStatus;

  try {
    status?.('Tor verified; preparing fresh pool identity.');
    const runInputs = await gatherInputs(opts.walletId, opts.utxos);
    const sumIn = runInputs.reduce((sum, input) => sum + input.value, 0);
    const tiers = P2P_TIERS.filter((tier) => sumIn > tier + 1_000);
    if (tiers.length === 0) throw new Error('Inputs too small for any P2P fusion tier.');

    const network = toPoolNetwork(opts.network);
    const now = Math.floor(Date.now() / 1_000);
    // Always schedule the NEXT epoch. Every window clicked within the same ~30s
    // bucket then targets the identical epoch and announces together — avoiding the
    // boundary split (one window jumps ahead, another doesn't) that produced "no
    // compatible P2P Fusion group". Peers just wait a few seconds for it to start.
    const epoch = poolEpoch(now) + 1;
    status?.('Waiting for the shared Fusion pool epoch (click all wallets within ~30s)…');
    await waitUntil(poolEpochStart(epoch) * 1_000, opts.signal);

    round = generateRoundIdentity();
    let peers: PoolAnnouncement[] = [
      {
        pubkey: round.pubkey,
        network,
        epoch,
        tiers,
        numInputs: runInputs.length,
        at: Math.floor(Date.now() / 1_000),
        expiresAt: poolEpochEnd(epoch) + POOL_EPOCH_GRACE_SECONDS,
      },
    ];
    const joined = joinPool(pool, relays, {
      round,
      network,
      epoch,
      tiers,
      numInputs: runInputs.length,
      onPeer: (received) => {
        const merged = new Map(peers.map((peer) => [peer.pubkey, peer]));
        received.forEach((peer) => merged.set(peer.pubkey, peer));
        peers = [...merged.values()];
      },
      onError: (error) => status?.(error.message),
    });
    stopPool = joined.stop;
    await joined.announceNow();
    opts.onPhase?.(1);
    status?.('Ephemeral kind-22230 announcement accepted; collecting peers…');

    const fresh = await collectEpoch(epoch, () => peers, status, opts.signal);
    joined.stop();
    stopPool = null;
    const group = selectFusionGroup(fresh, MIN_PARTICIPANTS, MAX_PARTICIPANTS);
    if (!group || !group.participants.includes(round.pubkey)) {
      throw new Error('No compatible P2P Fusion group formed in this epoch.');
    }

    const transport = createNostrRoundTransport(pool, relays, round, outputPool);
    const negotiated = await negotiateFusionRound(
      {
        myPubkey: round.pubkey,
        candidates: group.participants,
        network,
        tier: group.tier,
        epoch,
        signal: opts.signal,
      },
      transport
    );
    status?.(
      `Round agreed with ${negotiated.participants.length} peers at ${negotiated.tier} sats.`
    );

    const myInputs: FusionInputRef[] = runInputs.map((input) => ({
      prevTxid: input.prev_txid,
      prevIndex: input.prev_index,
      value: input.value,
      pubkey: input.pubkey,
    }));
    const outputPlan = planP2pOutputValues({
      inputs: myInputs,
      participantCount: negotiated.participants.length,
      feerate: P2P_FEERATE,
    });
    const outputScripts = await createFreshFusionOutputScripts(
      opts.walletId,
      opts.network,
      outputPlan.values.length
    );
    const keysByPubkey = new Map(
      runInputs.map((input) => [input.pubkey, hexToBin(input.privkey)])
    );
    const myOutputs: FusionOutputRef[] = outputScripts.map(
      (script, index) => ({ script, value: outputPlan.values[index] })
    );

    const result = await runFusionRound(
      {
        myPubkey: round.pubkey,
        participants: negotiated.participants,
        session: negotiated.session,
        tier: negotiated.tier,
        feerate: P2P_FEERATE,
        myContribution: { inputs: myInputs, outputs: myOutputs },
        keysByPubkey,
        broadcast: async (txHex) =>
          assertBroadcastTxid(await ElectrumService.broadcastTransaction(txHex)),
        onPhase: opts.onPhase,
      },
      transport
    );
    status?.(`Fused ✓ — txid ${result.txid}`);
    return result;
  } finally {
    stopPool?.();
    pool.close(relays);
    outputPool.close(relays);
    round?.secretKey.fill(0);
    disarmTorRouting();
  }
}
