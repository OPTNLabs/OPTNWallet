// P2P CashFusion orchestration over Nostr + Tor.
//
// A fresh 00-Wallet-style identity announces compatible tiers in a short,
// network-scoped epoch. The elected coordinator then proposes one exact peer
// set; every peer acknowledges before a random-session round_start is issued.
// No input/output registration starts from an independently frozen local view.

import { SimplePool } from 'nostr-tools';
import { useWebSocketImplementation as setNostrWebSocketImpl } from 'nostr-tools/pool';
import { invoke } from '@tauri-apps/api/core';
import { hash256 } from '@bitauth/libauth';

import { binToHex, hexToBin } from '../../utils/hex';
import { TorWebSocket, armTorRouting } from './nostr/torWebSocket';
import ElectrumService, {
  invalidateUTXOCache,
} from '../../services/ElectrumService';
import {
  isOwnRoundKey,
  outpointKey,
  recordRoundKey,
  releaseOutpoints,
  reserveOutpoints,
  reservedOutpoints,
} from './fusionRoundState';
import { Network } from '../../state/slices/networkSlice';
import type { UTXO } from '../../types/types';
import { reconcileActiveWalletUtxosForSpend } from '../../services/WalletUtxoRefreshService';
import {
  completeFusionBroadcast,
  fusionCompletionWarning,
} from './FusionCompletionService';
import { createFreshFusionOutputScripts, gatherInputs } from './FusionService';
import { isFusionExecutionAllowed } from './FusionExecutionSafety';
import {
  generateRoundIdentity,
  joinPool,
  poolEpoch,
  selectFusionGroup,
  POOL_PEER_TTL_SECONDS,
  MIN_PARTICIPANTS,
  MAX_PARTICIPANTS,
  type FusionPoolNetwork,
  type PoolAnnouncement,
  type RoundIdentity,
} from './nostr/fusion';
import { createNostrRoundTransport } from './nostr/fusionTransport';
import { negotiateFusionRound } from './nostr/fusionRendezvous';
import { runFusionRound, type RoundResult } from './nostr/fusionSession';
import { CREDENTIAL_SLOTS_PER_PEER } from './nostr/fusionBlindSchnorr';
import type { FusionInputRef, FusionOutputRef } from './nostr/fusionRound';
import { planP2pOutputValues } from './nostr/fusionP2pAllocation';
import { DEFAULT_RELAYS } from './nostr/chat';

const P2P_FEERATE = 1_000; // sats per 1000 bytes
const P2P_TIERS = [10_000, 100_000, 1_000_000, 10_000_000];
// Participant bounds live in nostr/fusion.ts so the pool, the rendezvous and
// this service cannot disagree. They did: this file capped a round at 10 while
// the rendezvous truncated the candidate list to 6, so four peers could be
// admitted here and then silently dropped downstream.
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
  const relays = Array.from(
    new Set(configured?.length ? configured : DEFAULT_RELAYS)
  )
    .filter((relay) => relay.startsWith('wss://'))
    .slice(0, MAX_RELAYS);
  if (relays.length === 0)
    throw new Error('No secure Nostr relays configured.');
  return relays;
}

function waitUntil(timestampMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted)
    return Promise.reject(new Error('fusion round cancelled'));
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

const POOL_WAIT_MIN_MS = 12_000; // short minimum gather so stragglers can still join
const POOL_WAIT_MAX_MS = 75_000; // give up gathering after this

// Rolling discovery: keep a running countdown and start the round as soon as enough
// FRESH peers (by TTL) are present after the minimum gather, or when the max wait
// elapses. No epoch bucket — peers who announced any time in the freshness window
// count, so users across the globe don't need to click together.
// A peer is ACTIVE only if it re-announced within this window. Peers re-announce
// every ~8s while running a round; an abandoned attempt (a stale throwaway key from
// an earlier click/retry) stops re-announcing and ages out — so the group is formed
// from currently-live wallets, not accumulated dead announcements.
// Must stay under POOL_PEER_TTL_SECONDS and above REANNOUNCE_MS (12s). Tor
// publish + relay fan-out can lag; 28s was so tight that slow relays aged out
// live peers mid-gather. 50s pairs with the 60s announcement TTL.
const RECENT_ACTIVE_SECONDS = 50;

// Every Start click mints a fresh throwaway identity, and the announcement is a
// STORED event the relay keeps replaying until it ages out. Without this, a retry
// discovers its OWN abandoned key as a peer: the same wallet joins its own round
// twice, contributes the same coins, and the round dies on "duplicate input".
// A wallet must never fuse with itself.
async function collectRolling(
  walletId: number,
  selfPubkey: string,
  getPeers: () => PoolAnnouncement[],
  onStatus?: (message: string) => void,
  signal?: AbortSignal
): Promise<PoolAnnouncement[]> {
  const start = Date.now();
  const minReady = start + POOL_WAIT_MIN_MS;
  const maxWait = start + POOL_WAIT_MAX_MS;
  const fresh = () => {
    const nowSeconds = Math.floor(Date.now() / 1_000);
    return getPeers().filter((peer) => {
      if (peer.pubkey === selfPubkey) return true;
      // An earlier attempt of THIS wallet — from any window, surviving reloads.
      if (isOwnRoundKey(walletId, peer.pubkey)) return false;
      return peer.at >= nowSeconds - RECENT_ACTIVE_SECONDS;
    });
  };
  for (;;) {
    if (signal?.aborted) throw new Error('fusion round cancelled');
    const peers = fresh();
    const now = Date.now();
    if (
      (peers.length >= MIN_PARTICIPANTS && now >= minReady) ||
      now >= maxWait
    ) {
      return peers;
    }
    if (peers.length >= MIN_PARTICIPANTS) {
      const inSecs = Math.max(0, Math.ceil((minReady - now) / 1_000));
      onStatus?.(`${peers.length} peers ready — starting in ${inSecs}s…`);
    } else {
      const secsLeft = Math.max(0, Math.ceil((maxWait - now) / 1_000));
      onStatus?.(
        `Waiting for peers: ${peers.length} present (up to ${secsLeft}s)…`
      );
    }
    await waitUntil(Math.min(maxWait, now + 1_500), signal);
  }
}

/**
 * Re-check every candidate coin against the LIVE UTXO set immediately before the
 * round. Fusion spends coins the UI cached in redux; if any were already spent
 * (an earlier attempt, another send, or a cache left stale by an Electrum
 * "Connection lost"), the assembled CoinJoin references a missing outpoint and
 * the network rejects the entire broadcast with "Missing inputs" — after every
 * peer has already signed and burned their fresh output addresses. Dropping dead
 * coins here is far cheaper than failing a whole multi-party round at the end.
 */
const UTXO_RECHECK_TIMEOUT_MS = 15_000;

/**
 * A peer may contribute at most CREDENTIAL_SLOTS_PER_PEER inputs to one round —
 * the blind-Schnorr issuer allocates exactly that many nonce slots per peer
 * (fusionBlindSchnorr.ts). Passing every wallet coin exceeded the slots and
 * every round aborted at credential-build with "too many inputs for credential
 * slots". Prefer the largest coins so the round still reaches a meaningful tier;
 * the remainder stays eligible for later rounds.
 */
function selectFusionInputs(utxos: UTXO[]): UTXO[] {
  return [...utxos]
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
    .slice(0, CREDENTIAL_SLOTS_PER_PEER);
}

async function onlyUnspent(
  utxos: UTXO[],
  signal?: AbortSignal
): Promise<UTXO[]> {
  if (signal?.aborted) throw new Error('fusion round cancelled');
  const addresses = Array.from(
    new Set(utxos.map((utxo) => utxo.address).filter(Boolean))
  );
  if (addresses.length === 0) return [];
  addresses.forEach((address) => invalidateUTXOCache(address));
  // Bounded, but NOT best-effort: contributing a coin we could not verify wastes
  // every participant's round (they all sign, then the network rejects the whole
  // transaction with "Missing inputs"). Refusing to join costs only us, so an
  // unreachable Electrum must fail the round rather than fall back to the
  // wallet's cached list.
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let abortListener: (() => void) | null = null;
  const live = await Promise.race([
    ElectrumService.getUTXOsMany(addresses),
    new Promise<null>((resolve) => {
      timeout = setTimeout(() => resolve(null), UTXO_RECHECK_TIMEOUT_MS);
    }),
    new Promise<never>((_resolve, reject) => {
      if (!signal) return;
      abortListener = () => reject(new Error('fusion round cancelled'));
      signal.addEventListener('abort', abortListener, { once: true });
      if (signal.aborted) abortListener();
    }),
  ]).finally(() => {
    if (timeout) clearTimeout(timeout);
    if (abortListener) {
      signal?.removeEventListener('abort', abortListener);
    }
  });
  if (!live) {
    throw new Error(
      'Could not confirm your coins are unspent (Electrum unreachable) — not risking the round.'
    );
  }
  // HOT-path getUTXOsMany omits failed addresses (missing key ≠ empty). Retry
  // those once per-address before aborting the whole round — a single blip
  // was killing every P2P attempt on multi-address wallets.
  const unverified = addresses.filter((address) => !(address in live));
  for (const address of unverified) {
    if (signal?.aborted) throw new Error('fusion round cancelled');
    try {
      invalidateUTXOCache(address);
      live[address] = await ElectrumService.getUTXOs(address);
    } catch {
      throw new Error(
        `Could not confirm address is unspent (Electrum error) — not risking the round.`
      );
    }
  }
  const unspent = new Set(
    Object.values(live)
      .flat()
      .map((utxo) => `${utxo.tx_hash}:${utxo.tx_pos}`)
  );
  return utxos.filter((utxo) => unspent.has(`${utxo.tx_hash}:${utxo.tx_pos}`));
}

export async function refreshAndVerifyP2pInputs(
  walletId: number,
  fallbackUtxos: UTXO[],
  signal?: AbortSignal
): Promise<UTXO[]> {
  if (signal?.aborted) throw new Error('fusion round cancelled');
  const refreshed = await reconcileActiveWalletUtxosForSpend(walletId, signal);
  if (signal?.aborted) throw new Error('fusion round cancelled');
  const candidates = refreshed
    ? Object.values(refreshed)
        .flat()
        .filter((utxo) => !utxo.token)
    : fallbackUtxos;
  const claimed = reservedOutpoints(walletId);
  const free = candidates.filter(
    (utxo) => !claimed.has(outpointKey(utxo.tx_hash, utxo.tx_pos))
  );
  if (free.length === 0) {
    throw new Error(
      candidates.length === 0
        ? 'No spendable (non-token) UTXOs to fuse.'
        : 'All coins are already committed to another fusion round.'
    );
  }

  const spendable = await onlyUnspent(free, signal);
  if (spendable.length === 0) {
    throw new Error(
      'No live unspent coins to fuse after refreshing the wallet.'
    );
  }
  return spendable;
}

const DEFINITIVE_BROADCAST_REJECTIONS = [
  /missing inputs/i,
  /mempool min fee not met/i,
  /mandatory-script-verify-flag/i,
  /non-mandatory-script-verify-flag/i,
  /txn-mempool-conflict/i,
  /bad-txns/i,
  /dust/i,
  /insufficient fee/i,
  /fee .*too (?:high|low)/i,
  /\bcode (?:-?25|-?26|64|66)\b/i,
];

export interface P2pBroadcastReceipt {
  txid: string;
  verified: boolean;
  warning?: string;
}

/**
 * Broadcast a VM-verified CoinJoin without turning an interrupted Electrum
 * response into a false rejection. Once a node may have accepted the bytes,
 * the wallet must track the locally derived txid so an automatic retry cannot
 * accidentally reuse the same inputs.
 */
export async function broadcastP2pTransaction(
  txHex: string,
  dependencies: {
    broadcast: (rawTx: string) => Promise<string>;
    visibility: (
      txid: string
    ) => Promise<{ seen: boolean; confirmed: boolean }>;
  } = {
    broadcast: (rawTx) => ElectrumService.broadcastTransaction(rawTx),
    visibility: (txid) => ElectrumService.getTransactionVisibility(txid),
  }
): Promise<P2pBroadcastReceipt> {
  const expectedTxid = binToHex(hash256(hexToBin(txHex)).reverse());
  let response: string;
  try {
    response = await dependencies.broadcast(txHex);
  } catch (error) {
    response = error instanceof Error ? error.message : String(error);
  }

  if (/^[0-9a-f]{64}$/i.test(response)) {
    if (response.toLowerCase() === expectedTxid) {
      return { txid: expectedTxid, verified: true };
    }
  } else if (
    DEFINITIVE_BROADCAST_REJECTIONS.some((pattern) => pattern.test(response))
  ) {
    throw new Error(`Fusion broadcast rejected: ${response}`);
  }

  const visibility = await dependencies
    .visibility(expectedTxid)
    .catch(() => ({ seen: false, confirmed: false }));
  if (visibility.seen) {
    return { txid: expectedTxid, verified: true };
  }

  return {
    txid: expectedTxid,
    verified: false,
    warning:
      'The node response was interrupted, so broadcast status is not yet confirmed. The signed transaction is safely tracked while wallet sync verifies it.',
  };
}

/** Run one P2P round on the active BCH network. */
export async function runP2pFusion(
  opts: P2pFusionOptions
): Promise<RoundResult & { warning?: string }> {
  if (!isFusionExecutionAllowed())
    throw new Error('P2P fusion execution is paused.');
  if (!opts.tor) {
    throw new Error(
      'Tor is required for P2P fusion — enable Tor and wait for bootstrap.'
    );
  }
  if (opts.signal?.aborted) throw new Error('fusion round cancelled');

  const torOk = await invoke<boolean>('fusion_tor_check', {
    host: opts.tor.host,
    port: opts.tor.port,
  });
  if (opts.signal?.aborted) throw new Error('fusion round cancelled');
  if (!torOk) throw new Error('Tor is not reachable — P2P fusion stopped.');

  const relays = validatedRelays(opts.relays);
  if (!wsInstalled) {
    setNostrWebSocketImpl(TorWebSocket);
    wsInstalled = true;
  }
  const pool = new SimplePool();
  // Output registrations get different relay sockets and Tor isolation streams.
  const outputPool = new SimplePool();
  let releaseTorRouting: (() => void) | null = null;
  let stopPool: (() => void) | null = null;
  let round: RoundIdentity | null = null;
  let reservedForRound: string[] = [];
  let withdrawFromPool: (() => Promise<void>) | null = null;
  const status = opts.onStatus;

  try {
    releaseTorRouting = armTorRouting({
      host: opts.tor.host,
      port: opts.tor.port,
    });
    status?.('Refreshing and verifying live wallet coins.');
    // Drop coins another round of this wallet is already spending. Without this,
    // two rounds (two windows, or a retry overlapping its predecessor) pick the
    // same UTXOs; the first to broadcast spends them and the second is rejected
    // with "Missing inputs" only after every peer has signed.
    const spendable = selectFusionInputs(
      await refreshAndVerifyP2pInputs(opts.walletId, opts.utxos, opts.signal)
    );
    if (opts.signal?.aborted) throw new Error('fusion round cancelled');
    status?.('Tor verified; preparing fresh pool identity.');
    reservedForRound = spendable.map((utxo) =>
      outpointKey(utxo.tx_hash, utxo.tx_pos)
    );
    reserveOutpoints(opts.walletId, reservedForRound);
    const runInputs = await gatherInputs(opts.walletId, spendable);
    if (opts.signal?.aborted) throw new Error('fusion round cancelled');
    const sumIn = runInputs.reduce((sum, input) => sum + input.value, 0);
    // Refuse before announcing if this wallet cannot fund the allocator's
    // minimum two outputs plus its measured fee. Recruiting peers into a round
    // that is guaranteed to fail after rendezvous only creates ghost entries.
    planP2pOutputValues({
      inputs: runInputs.map((input) => ({
        value: input.value,
        pubkey: input.pubkey,
      })),
      participantCount: MIN_PARTICIPANTS,
      feerate: P2P_FEERATE,
      randomUnit: () => 0.5,
    });
    const tiers = P2P_TIERS.filter((tier) => sumIn > tier + 1_000);
    if (tiers.length === 0)
      throw new Error('Inputs too small for any P2P fusion tier.');

    const network = toPoolNetwork(opts.network);
    const now = Math.floor(Date.now() / 1_000);
    // Rolling network-wide pool (00-Wallet model): announce immediately and gather
    // whoever is fresh; no epoch bucket to synchronize on. epoch is an info stamp.
    const epoch = poolEpoch(now);

    round = generateRoundIdentity();
    recordRoundKey(opts.walletId, round.pubkey);
    let peers: PoolAnnouncement[] = [
      {
        pubkey: round.pubkey,
        network,
        epoch,
        tiers,
        numInputs: runInputs.length,
        at: now,
        expiresAt: now + POOL_PEER_TTL_SECONDS,
      },
    ];
    const joined = joinPool(pool, relays, {
      round,
      network,
      epoch,
      tiers,
      numInputs: runInputs.length,
      signal: opts.signal,
      onPeer: (received) => {
        const merged = new Map(peers.map((peer) => [peer.pubkey, peer]));
        received.forEach((peer) => merged.set(peer.pubkey, peer));
        peers = [...merged.values()];
      },
      onError: (error) => status?.(error.message),
    });
    stopPool = joined.stop;
    withdrawFromPool = joined.withdraw;
    await joined.announceNow();
    opts.onPhase?.(1);
    status?.('Pool announcement published; collecting peers…');

    const fresh = await collectRolling(
      opts.walletId,
      round.pubkey,
      () => peers,
      status,
      opts.signal
    );
    joined.stop();
    stopPool = null;
    const group = selectFusionGroup(fresh, MIN_PARTICIPANTS, MAX_PARTICIPANTS);
    if (!group || !group.participants.includes(round.pubkey)) {
      throw new Error('No compatible P2P Fusion group formed in this epoch.');
    }

    const transport = createNostrRoundTransport(
      pool,
      relays,
      round,
      outputPool,
      opts.signal
    );
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
    // The onion peeler looks its key up by `myPubkey`, which is the Nostr round
    // identity — not one of the BCH input pubkeys above. Without this entry the
    // peel throws "private key not found for onion peeling" and the round dies.
    // The tests already supplied it; production never did.
    keysByPubkey.set(round.pubkey, round.secretKey);
    const myOutputs: FusionOutputRef[] = outputScripts.map((script, index) => ({
      script,
      value: outputPlan.values[index],
    }));

    let broadcastWarning: string | undefined;
    const result = await runFusionRound(
      {
        myPubkey: round.pubkey,
        participants: negotiated.participants,
        session: negotiated.session,
        tier: negotiated.tier,
        feerate: P2P_FEERATE,
        myContribution: { inputs: myInputs, outputs: myOutputs },
        keysByPubkey,
        // Route outputs through the peer mix-net. Without this the coordinator
        // sees, in one message, exactly which outputs belong to which peer —
        // the message boundary is itself the grouping, so a fresh signing key
        // does not help. Costs no extra infrastructure: the peers are the mix
        // and the existing Nostr relays are the transport.
        onionEnabled: true,
        signal: opts.signal,
        broadcast: async (txHex) => {
          try {
            const receipt = await broadcastP2pTransaction(txHex);
            broadcastWarning = receipt.warning;
            return receipt.txid;
          } catch (error) {
            // A rejected CoinJoin does not identify which input became stale.
            // Re-check our own inputs so the user gets a useful, bounded verdict
            // without writing the raw transaction or wallet outpoints to logs.
            const survivors = await onlyUnspent(
              spendable,
              opts.signal
            ).catch(() => null);
            const verdict =
              survivors === null
                ? 'could not re-check (Electrum unreachable)'
                : survivors.length === spendable.length
                  ? `all ${spendable.length} of OUR inputs still unspent — the dead input came from a PEER`
                  : `${spendable.length - survivors.length} of OUR ${spendable.length} inputs vanished DURING the round`;
            console.error('[p2p-fusion] broadcast rejected:', verdict);
            status?.(`Broadcast rejected — ${verdict}`);
            throw error;
          }
        },
        onPhase: opts.onPhase,
      },
      transport
    );
    const completion = await completeFusionBroadcast({
      walletId: opts.walletId,
      txid: result.txid,
      txHex: result.txHex,
      spentInputs: spendable,
      source: 'p2p-fusion',
      sourceLabel: 'P2P Fusion',
      // The scripts we allocated for ourselves this round. The completion layer
      // resolves them to txid:index — a round shuffles its outputs so position
      // carries no information, and guessing an index here would eventually
      // credit a peer's coin to us.
      ownedOutputScripts: outputScripts,
    });
    const warning = [broadcastWarning, fusionCompletionWarning(completion)]
      .filter((message): message is string => Boolean(message))
      .join(' ');
    status?.(
      warning
        ? `Fused ✓ — txid ${result.txid}. ${warning}`
        : `Fused ✓ — txid ${result.txid}`
    );
    return warning.length > 0 ? { ...result, warning } : result;
  } finally {
    // Free the coins whatever happened. A successful round has already spent
    // them (the live re-check keeps them out next time); a failed one must not
    // strand them. The stored TTL is only a backstop for a hard crash.
    releaseOutpoints(opts.walletId, reservedForRound);
    // Retire this round key from the pool before tearing the sockets down, so the
    // next attempt (ours or a peer's) does not see it as a live candidate.
    await withdrawFromPool?.().catch(() => undefined);
    stopPool?.();
    pool.close(relays);
    outputPool.close(relays);
    round?.secretKey.fill(0);
    releaseTorRouting?.();
  }
}
