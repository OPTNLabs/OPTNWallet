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
  clearOutpointReservations,
  isOwnRoundKey,
  isRetiredRoundKey,
  outpointKey,
  recordRoundKey,
  releaseOutpoints,
  reserveOutpoints,
  reservedOutpoints,
  retireAllOwnRoundKeys,
  retireRoundKey,
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
  invalidateJoinPoolAnnouncers,
  isLivePoolAnnouncement,
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
import {
  P2P_COMPONENT_JITTER_MS,
  P2P_GATHER_MAX_MS,
  P2P_GATHER_MIN_MS,
  P2P_PEAK_GRACE_MS,
  P2P_PEER_SET_STABLE_MS,
  P2P_PROPOSAL_TIMEOUT_MS,
  P2P_RENDEZVOUS_MS,
  P2P_ROUND_TIMEOUT_MS,
  P2P_SMALL_SET_HOLD_MS,
} from './fusionTiming';
import { log } from './logger';

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

// Evidence (user): each of 4 wallets shows a DIFFERENT peer count (1 / 4 / 5 / …)
// then "agreed" on a tiny subset. Causes:
//   1) Tor delivers stored announcements unevenly
//   2) Ghost keys from earlier Start clicks (failed/withdrawn rounds) still in
//      the local peer Map — one window sees 5 keys, another only 2 live wallets
//   3) Early lock on count===2 while a 3rd wallet is still connecting
//   4) Stability checked on COUNT only — membership can churn at same size
// Gather budgets mirror server JOIN_WAIT (fusionTiming) — never invent a longer
// pool wait than Electron Cash / protocol.py.
const POOL_WAIT_MIN_MS = P2P_GATHER_MIN_MS;
const POOL_WAIT_MAX_MS = P2P_GATHER_MAX_MS;
const PEER_SET_STABLE_MS = P2P_PEER_SET_STABLE_MS;
const SMALL_SET_HOLD_MS = P2P_SMALL_SET_HOLD_MS;
// Every Start click mints a fresh throwaway identity, and the announcement is a
// STORED event the relay keeps replaying until it ages out. Without this, a retry
// discovers its OWN abandoned key as a peer: the same wallet joins its own round
// twice, contributes the same coins, and the round dies on "duplicate input".
// A wallet must never fuse with itself.
//
// Live filter = re-announce proof-of-life (see isLivePoolAnnouncement). A plain
// "created_at within 14–24s" window still counted abandoned Start keys right
// after a restart (user: 4 wallets, "7 live peers").
async function collectRolling(
  walletId: number,
  selfPubkey: string,
  getPeers: () => PoolAnnouncement[],
  onStatus?: (message: string) => void,
  signal?: AbortSignal,
  /** Re-publish when alone so late Tor peers still find us. */
  announceNow?: () => Promise<void>
): Promise<PoolAnnouncement[]> {
  const start = Date.now();
  const gatherStartSeconds = Math.floor(start / 1_000);
  const minReady = start + POOL_WAIT_MIN_MS;
  const maxWait = start + POOL_WAIT_MAX_MS;
  let lastFingerprint = '';
  let stableSince = start;
  let lastLoggedFp = '';
  let lastAnnounceBoost = 0;
  /** Peak soft / strict sizes this gather — used to avoid locking 2-of-4 early. */
  let peakSoft = 0;
  let peakStrict = 0;
  /** Last time live strict count was still at its peak (for grace after drop). */
  let lastAtPeakMs = start;
  /** Last time soft ≤ strict (soft lag grace). */
  let lastSoftCaughtUpMs = start;
  const ghostKey = (pubkey: string) =>
    isOwnRoundKey(walletId, pubkey) || isRetiredRoundKey(pubkey);
  /** Soft filter while waiting (shows approximate count). */
  const softLive = () => {
    const nowSeconds = Math.floor(Date.now() / 1_000);
    return getPeers().filter((peer) =>
      isLivePoolAnnouncement(peer, {
        nowSeconds,
        gatherStartSeconds,
        selfPubkey,
        isGhostKey: ghostKey,
      })
    );
  };
  /**
   * Hard filter at lock / propose: only keys re-published during THIS gather.
   * Ghosts from earlier Starts never re-announce → dropped. Without this,
   * propose(6) with 4 real wallets → only 2 ACK → 2 fuse, 2 left out.
   */
  const lockLive = () => {
    const nowSeconds = Math.floor(Date.now() / 1_000);
    return getPeers().filter((peer) =>
      isLivePoolAnnouncement(peer, {
        nowSeconds,
        gatherStartSeconds,
        selfPubkey,
        isGhostKey: ghostKey,
        lockStrict: true,
      })
    );
  };
  const fingerprint = (peers: PoolAnnouncement[]) =>
    peers
      .map((p) => p.pubkey)
      .sort()
      .join(',');
  for (;;) {
    if (signal?.aborted) throw new Error('fusion round cancelled');
    const soft = softLive();
    const peers = lockLive();
    const now = Date.now();
    peakSoft = Math.max(peakSoft, soft.length);
    peakStrict = Math.max(peakStrict, peers.length);
    // Refresh peak clock only while we still SEE the peak size. When others
    // leave/fuse, this freezes and peak-grace can expire.
    if (peakStrict > 0 && peers.length >= peakStrict) {
      lastAtPeakMs = now;
    }
    if (soft.length <= peers.length) {
      lastSoftCaughtUpMs = now;
    }
    // Stability on the STRICT set so ghost drop does not count as "stable 6".
    const fp = fingerprint(peers);
    if (fp !== lastFingerprint) {
      lastFingerprint = fp;
      stableSince = now;
    }
    if (fp !== lastLoggedFp) {
      lastLoggedFp = fp;
      const keys =
        peers.map((p) => p.pubkey.slice(0, 8)).join(', ') || '(none)';
      console.info(
        `[p2p-fusion] live set strict=${peers.length} soft=${soft.length} peak=${peakStrict}/${peakSoft}:`,
        keys
      );
      // Live multi-wallet debug: same line lands in optn-wallet.log for tailing.
      void log.info(
        'p2p-live',
        `w${walletId} strict=${peers.length} soft=${soft.length} peak=${peakStrict}/${peakSoft} keys=${keys}`
      );
    }
    // Alone or under-count: re-shout often so a lagging Tor peer still finds us.
    if (
      peers.length < Math.max(3, peakSoft, peakStrict) &&
      announceNow &&
      now - lastAnnounceBoost > 3_000
    ) {
      lastAnnounceBoost = now;
      void announceNow().catch(() => undefined);
    }
    const pastMin = now >= minReady;
    const setStable = pastMin && now - stableSince >= PEER_SET_STABLE_MS;
    const peakGraceLeft = Math.max(
      0,
      P2P_PEAK_GRACE_MS - (now - lastAtPeakMs)
    );
    const peakGraceExpired = peakGraceLeft === 0;
    // Soft lag / peak drop only block EARLY lock for a short grace. Forever
    // "peak 4/4 now 2" was a hang: others already Registered without us.
    const expectMoreFromSoft =
      soft.length > peers.length &&
      now - lastSoftCaughtUpMs < P2P_PEAK_GRACE_MS;
    const lostFromPeak = peakStrict > peers.length && peakStrict >= 3;
    const expectMoreFromPeak = lostFromPeak && !peakGraceExpired;
    const expectMore = expectMoreFromSoft || expectMoreFromPeak;
    // Policy (≤ server JOIN_WAIT):
    //   • 4+: lock when stable and not mid-grace lag
    //   • 3:  stable + hold, unless expectMore
    //   • 2:  if we never saw 3+ → wait until maxWait (room for a 3rd);
    //         if we HAD 3+ and they left (grace expired) → lock the pair now
    //         (user: stuck "peak 4/4" with 2 left while others already fused)
    const trioReady =
      peers.length === 3 &&
      setStable &&
      now >= start + SMALL_SET_HOLD_MS &&
      !expectMore;
    const pairAfterAbandonedPeak =
      peers.length === 2 &&
      setStable &&
      peakStrict >= 3 &&
      peakGraceExpired;
    const canLock =
      peers.length >= 4
        ? setStable && !expectMore
        : trioReady || pairAfterAbandonedPeak;
    // Live: w4 kept shouting ~100s after w1+w6 fused (peak 3 → alone).
    // Once we HAD peers and peak-grace expired with only self left, stop —
    // they are not coming back this gather; full JOIN_WAIT is wasted budget.
    if (
      peers.length < MIN_PARTICIPANTS &&
      peakStrict >= 2 &&
      peakGraceExpired &&
      now - start >= P2P_PEAK_GRACE_MS
    ) {
      throw new Error(
        `No peers left (peak was ${peakStrict}, now only you). ` +
          `Others already fused or left the pool — Cancel is automatic; ` +
          `Start ALL wallets together for the next round.`
      );
    }
    if (canLock || now >= maxWait) {
      onStatus?.(
        `Gather done: ${peers.length} active wallet(s) ` +
          `(soft ${soft.length}, peak strict/soft ${peakStrict}/${peakSoft}; ` +
          `stable=${canLock}, ${Math.round((now - start) / 1000)}s).`
      );
      return peers;
    }
    const keyHint =
      peers.length > 0
        ? ` [${peers.map((p) => p.pubkey.slice(0, 6)).join(' ')}]`
        : soft.length > 1
          ? ` [soft ${soft.length}…]`
          : '';
    const secsLeft = Math.max(0, Math.ceil((maxWait - now) / 1_000));
    if (peers.length < 2) {
      const aloneAfterOthers =
        peakStrict >= 2 && peakGraceLeft > 0
          ? ` Peers left (peak ${peakStrict}); giving up in ${Math.ceil(peakGraceLeft / 1000)}s if no one returns…`
          : now - start > 12_000
            ? ' Still shouting — if others already fused, Cancel + Start ALL together.'
            : soft.length > 1 || peakSoft > 1
              ? ' Dropping ghosts; waiting for re-announces…'
              : ' Waiting for other wallets (Tor)…';
      onStatus?.(
        `Only you confirmed active${keyHint} (up to ${secsLeft}s).${aloneAfterOthers}`
      );
    } else if (peers.length === 2) {
      if (lostFromPeak && !peakGraceExpired) {
        onStatus?.(
          `2 active${keyHint} — peak was ${peakStrict}; waiting ${Math.ceil(peakGraceLeft / 1000)}s ` +
            `for dropouts, then fuse as a pair if they stay gone…`
        );
      } else if (peakStrict >= 3 && peakGraceExpired) {
        onStatus?.(
          `2 active${keyHint} — peak ${peakStrict} left; locking pair shortly…`
        );
      } else {
        onStatus?.(
          `2 active${keyHint} — holding pair for a 3rd wallet (${secsLeft}s left; ` +
            `true 2-wallet rounds start when this timer ends)…`
        );
      }
    } else if (peers.length >= MIN_PARTICIPANTS && pastMin) {
      const needStable = Math.max(
        0,
        Math.ceil((PEER_SET_STABLE_MS - (now - stableSince)) / 1_000)
      );
      const holdNote = expectMore
        ? ` waiting up to ${Math.ceil(peakGraceLeft / 1000)}s for peak ${peakStrict}`
        : peers.length === 3
          ? ` hold ${Math.max(0, Math.ceil((start + SMALL_SET_HOLD_MS - now) / 1000))}s for a 4th`
          : '';
      onStatus?.(
        `${peers.length} active${keyHint} — ${needStable}s stable${holdNote}…`
      );
    } else if (peers.length >= MIN_PARTICIPANTS) {
      const inSecs = Math.max(0, Math.ceil((minReady - now) / 1_000));
      onStatus?.(
        `${peers.length} active wallet(s)${keyHint} — min gather ${inSecs}s…`
      );
    } else {
      onStatus?.(
        `Waiting: ${peers.length} active${keyHint} (up to ${secsLeft}s)…`
      );
    }
    await waitUntil(Math.min(maxWait, now + 2_000), signal);
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
  signal?: AbortSignal,
  options?: { preferProvided?: boolean }
): Promise<UTXO[]> {
  if (signal?.aborted) throw new Error('fusion round cancelled');
  const claimed = reservedOutpoints(walletId);
  const nonToken = (list: UTXO[]) =>
    list.filter(
      (utxo) => !utxo.token && !claimed.has(outpointKey(utxo.tx_hash, utxo.tx_pos))
    );

  // Prefer the runner's already-reconciled coins (skip a second exclusive
  // listunspent that blocked multi-wallet P2P on "Refreshing coins…").
  let free = options?.preferProvided ? nonToken(fallbackUtxos) : [];
  if (free.length === 0) {
    const refreshed = await reconcileActiveWalletUtxosForSpend(walletId, signal);
    if (signal?.aborted) throw new Error('fusion round cancelled');
    const candidates = refreshed
      ? Object.values(refreshed)
          .flat()
          .filter((utxo) => !utxo.token)
      : fallbackUtxos;
    free = nonToken(candidates);
    if (free.length === 0) {
      throw new Error(
        candidates.length === 0
          ? 'No spendable (non-token) UTXOs to fuse.'
          : 'All coins are already committed to another fusion round.'
      );
    }
  }

  let spendable: UTXO[];
  try {
    spendable = await onlyUnspent(free, signal);
  } catch (error) {
    // Exclusive reconcile already listed these. A second Electrum pass that
    // times out should not kill auto after a successful fuse (0-conf lag / blip).
    if (options?.preferProvided && free.length > 0) {
      console.warn(
        '[p2p-fusion] onlyUnspent failed; using exclusive-reconciled coins:',
        error instanceof Error ? error.message : error
      );
      return free;
    }
    throw error;
  }
  if (spendable.length === 0) {
    // After a paid fuse, new outputs are often 0-conf and listunspent can lag
    // the exclusive snapshot by seconds. PreferProvided coins came from that
    // snapshot — empty recheck usually means lag, not "no coins".
    if (options?.preferProvided && free.length > 0) {
      console.warn(
        `[p2p-fusion] onlyUnspent empty for ${free.length} exclusive coin(s); ` +
          'using them (likely 0-conf / Electrum lag after prior fuse).'
      );
      return free;
    }
    throw new Error(
      'No live unspent coins to fuse after refreshing the wallet. ' +
        'If you just fused, wait a few seconds for Electrum to see the new coins, then try again.'
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
    // Runner already did exclusive listunspent. Prefer a light reserved-filter +
    // unspent check on those coins so 4 wallets do not stampede Electrum again
    // and sit on "Refreshing coins…" until the gather window expires alone.
    status?.('Verifying coins for this round…');
    const spendable = selectFusionInputs(
      await refreshAndVerifyP2pInputs(opts.walletId, opts.utxos, opts.signal, {
        preferProvided: true,
      })
    );
    if (opts.signal?.aborted) throw new Error('fusion round cancelled');
    status?.('Tor verified; publishing pool identity…');
    // Order matters: clear stranded locks from a crashed prior round FIRST, then
    // claim THIS round's coins. Previously clearOutpointReservations ran after
    // reserveOutpoints and wiped the live reservation (coins looked free while
    // fusing; second Start could double-claim).
    invalidateJoinPoolAnnouncers();
    // Retire every previous throwaway of THIS wallet so other windows stop
    // counting double-Start keys (4 wallets → 6–7 "live").
    retireAllOwnRoundKeys(opts.walletId);
    clearOutpointReservations(opts.walletId);
    reservedForRound = spendable.map((utxo) =>
      outpointKey(utxo.tx_hash, utxo.tx_pos)
    );
    reserveOutpoints(opts.walletId, reservedForRound);

    // Announce BEFORE gatherInputs. Fetching privkeys (IPC per coin) can take
    // many seconds on a lagging wallet — while that ran, others already locked
    // "4 active" and entered Propose/ACK without the slow one (wallet 5/8).
    // Pool discovery only needs sum + tier list + input count; keys load in
    // parallel with collectRolling.
    const sumIn = spendable.reduce(
      (sum, utxo) => sum + (utxo.value ?? Number(utxo.amount ?? 0)),
      0
    );
    // Provisional compressed pubkeys (same byte length as real) so the fee
    // refuse-check matches production sizing without waiting on KeyService.
    const provisionalPubkey = `02${'11'.repeat(32)}`;
    planP2pOutputValues({
      inputs: spendable.map((utxo) => ({
        value: utxo.value ?? Number(utxo.amount ?? 0),
        pubkey: provisionalPubkey,
      })),
      participantCount: MIN_PARTICIPANTS,
      feerate: P2P_FEERATE,
      randomUnit: () => 0.5,
    });
    const tiers = P2P_TIERS.filter((tier) => sumIn > tier + 1_000);
    if (tiers.length === 0)
      throw new Error('Inputs too small for any P2P fusion tier.');
    const numInputs = spendable.length;

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
        numInputs,
        at: now,
        seenAt: now,
        expiresAt: now + POOL_PEER_TTL_SECONDS,
      },
    ];
    const joined = joinPool(pool, relays, {
      round,
      network,
      epoch,
      tiers,
      numInputs,
      signal: opts.signal,
      onPeer: (received) => {
        // REPLACE, do not union. The old merge kept every key ever seen for the
        // whole gather even after joinPool dropped retired/stale ghosts — that
        // alone produced "7 live" with 4 wallets after a few Start retries.
        const nowSec = Math.floor(Date.now() / 1_000);
        const byKey = new Map(received.map((peer) => [peer.pubkey, peer]));
        const self = peers.find((peer) => peer.pubkey === round!.pubkey);
        if (self && !byKey.has(round!.pubkey)) {
          byKey.set(round!.pubkey, {
            ...self,
            at: nowSec,
            seenAt: nowSec,
          });
        }
        peers = [...byKey.values()];
      },
      onError: (error) => status?.(error.message),
    });
    stopPool = joined.stop;
    withdrawFromPool = joined.withdraw;
    await joined.announceNow();
    opts.onPhase?.(1);
    status?.(
      'Pool announcement published; collecting peers (loading signing keys in background)…'
    );

    // Abort gather if peer collect cancels (and vice versa) so a slow key load
    // does not outlive a cancelled round.
    const prepAbort = new AbortController();
    const forwardAbort = () => prepAbort.abort();
    opts.signal?.addEventListener('abort', forwardAbort, { once: true });
    if (opts.signal?.aborted) prepAbort.abort();
    let runInputs: Awaited<ReturnType<typeof gatherInputs>>;
    let fresh: PoolAnnouncement[];
    try {
      const keysPromise = gatherInputs(opts.walletId, spendable).catch(
        (error) => {
          prepAbort.abort();
          throw error;
        }
      );
      const peersPromise = collectRolling(
        opts.walletId,
        round.pubkey,
        () => peers,
        status,
        prepAbort.signal,
        () => joined.announceNow()
      ).catch((error) => {
        prepAbort.abort();
        throw error;
      });
      [runInputs, fresh] = await Promise.all([keysPromise, peersPromise]);
    } finally {
      opts.signal?.removeEventListener('abort', forwardAbort);
    }
    if (opts.signal?.aborted) throw new Error('fusion round cancelled');
    if (runInputs.length === 0) {
      throw new Error('No signing keys for fusion inputs.');
    }
    // Keep re-announcing through negotiate so late wallets still see us.
    // (Stopping here was one cause of "only 1 announcement" on other windows.)
    const group = selectFusionGroup(fresh, MIN_PARTICIPANTS, MAX_PARTICIPANTS);
    if (!group || !group.participants.includes(round.pubkey)) {
      retireRoundKey(round.pubkey);
      joined.stop();
      stopPool = null;
      throw new Error(
        `No P2P peers found (only ${fresh.length} live wallet(s); need ≥2 wallets ` +
          `on ${network} with Tor + P2P on, starting around the same time). ` +
          `Open a second chipnet wallet and Start P2P on both.`
      );
    }
    status?.(
      `Proposing ${group.participants.length} active wallet(s) at ${group.tier} sats ` +
        `(gathered ${fresh.length}). Waiting for every proposed wallet to ACK — ` +
        `this is what keeps all ${group.participants.length} in the same round…`
    );

    const transport = createNostrRoundTransport(
      pool,
      relays,
      round,
      outputPool,
      opts.signal
    );
    let negotiated;
    try {
      negotiated = await negotiateFusionRound(
        {
          myPubkey: round.pubkey,
          candidates: group.participants,
          network,
          tier: group.tier,
          epoch,
          // Caps from fusionTiming (≤ server T_START_CLOSE / T_END_COMPS).
          timeoutMs: P2P_RENDEZVOUS_MS,
          proposalTimeoutMs: P2P_PROPOSAL_TIMEOUT_MS,
          signal: opts.signal,
        },
        transport
      );
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      // Surface a single actionable line on the CashFusion panel.
      if (/timed out|timeout/i.test(raw)) {
        throw new Error(
          `Could not agree on a round (${group.participants.length} in your view). ` +
            `The other wallets may have already fused without you. ` +
            `Start P2P again on ALL wallets at the same time.`
        );
      }
      throw error;
    } finally {
      joined.stop();
      stopPool = null;
    }
    // Belt-and-suspenders: rendezvous must never return a shrunk set (2-of-4
    // "Continuing…" left late wallets alone worldwide — not scalable).
    if (negotiated.participants.length < group.participants.length) {
      throw new Error(
        `Round shrank to ${negotiated.participants.length}/${group.participants.length} ` +
          `wallets — refusing partial fuse. Start P2P on ALL wallets together.`
      );
    }
    status?.(
      `Round agreed with all ${negotiated.participants.length} wallets at ${negotiated.tier} sats.`
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
        // Output onion is mandatory for P2P privacy among peers (peel + shuffle).
        // Never disable in production — partial unlinkability (throwaway Nostr
        // authors alone) is not a substitute.
        onionEnabled: true,
        // ≤ server T_START_CLOSE_BLAME; tight jitter so inject fits comps window.
        timeoutMs: P2P_ROUND_TIMEOUT_MS,
        jitterMs: P2P_COMPONENT_JITTER_MS,
        signal: opts.signal,
        onStatus: status,
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
    // Retire this throwaway key for ALL windows (ghost peer filter), then
    // publish expired announcement so relays stop replaying us as live.
    if (round?.pubkey) retireRoundKey(round.pubkey);
    await withdrawFromPool?.().catch(() => undefined);
    stopPool?.();
    pool.close(relays);
    outputPool.close(relays);
    round?.secretKey.fill(0);
    releaseTorRouting?.();
  }
}
