// P2P CashFusion orchestration over Nostr + Tor.
//
// A fresh 00-Wallet-style identity announces compatible tiers in a short,
// network-scoped epoch. The elected coordinator then proposes one exact peer
// set; every peer acknowledges before a random-session round_start is issued.
// No input/output registration starts from an independently frozen local view.

import { SimplePool } from 'nostr-tools';
import { useWebSocketImplementation as setNostrWebSocketImpl } from 'nostr-tools/pool';
import { invoke } from '@tauri-apps/api/core';
import { encodeTransaction, hash256, sha256 } from '@bitauth/libauth';

import { binToHex, hexToBin } from '../../utils/hex';
import { TorWebSocket, armTorRouting } from './nostr/torWebSocket';
import ElectrumService, {
  invalidateUTXOCache,
} from '../../services/ElectrumService';
import OutboundTransactionTracker from '../../services/OutboundTransactionTracker';
import {
  clearOutpointReservations,
  isBlamedSessionKey,
  isOwnRoundKey,
  isRetiredRoundKey,
  outpointKey,
  recordBlamedSessionKey,
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
  defaultRelayEndpoints,
  inputLookupEndpoints,
  type FusionRelayObservation,
} from './ServerFusionRunner';
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
import { MAX_INPUT_CREDENTIALS_PER_PEER } from './nostr/fusionBlindSchnorr';
import {
  minimumFee,
  type AssembledFusionTx,
  type FusionInputRef,
  type FusionOutputRef,
  type PeerContribution,
} from './nostr/fusionRound';
import { toLibauthTx, type InputSig } from './nostr/fusionSign';
import { planP2pOutputValues } from './nostr/fusionP2pAllocation';
import {
  P2P_COMPONENT_JITTER_MS,
  P2P_GATHER_ALONE_AUTO_MS,
  P2P_GATHER_ALONE_MS,
  P2P_GATHER_FAST_WARMUP_MS,
  P2P_GATHER_MAX_MS,
  P2P_GATHER_MIN_MS,
  P2P_PEAK_GRACE_MS,
  P2P_PEER_SET_STABLE_FAST_MS,
  P2P_PEER_SET_STABLE_MS,
  P2P_PROPOSAL_TIMEOUT_MS,
  P2P_RENDEZVOUS_MS,
  P2P_ROUND_TIMEOUT_MS,
  P2P_SMALL_SET_HOLD_MS,
} from './fusionTiming';
import { log } from './logger';

const P2P_FEERATE = 1_000; // sats per 1000 bytes
// Sat tiers (privacy size bands). Cap is MAX_TIERS=16 in nostr/fusion.ts.
// 1 BCH = 100_000_000 so large wallets can meet without dumping full balance.
const P2P_TIERS = [
  10_000, // 0.0001 BCH
  100_000, // 0.001 BCH
  1_000_000, // 0.01 BCH
  10_000_000, // 0.1 BCH
  100_000_000, // 1 BCH
];
// Participant bounds live in nostr/fusion.ts so the pool, the rendezvous and
// this service cannot disagree. They did: this file capped a round at 10 while
// the rendezvous truncated the candidate list to 6, so four peers could be
// admitted here and then silently dropped downstream.
/**
 * Proven multi-wallet core (live fused many 3–4 ways 02:08–03:54 today).
 * Always use this set for P2P — do NOT fan out to the full 30-chat bootstrap
 * list. Expanding to 30 + first-OK over Tor later left every wallet alone.
 * Same order on every window so announce/subscribe topology matches.
 */
/**
 * Shared bootstrap relays for P2P discovery (same ordered list for every
 * client). Kept modest so Tor under many concurrent users stays usable.
 */
const FUSION_CORE_RELAYS: readonly string[] = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://relay.snort.social',
  'wss://offchain.pub',
  'wss://nostr.oxtr.dev',
];
const MAX_ANNOUNCE_RELAYS = FUSION_CORE_RELAYS.length;
/** Round hops: same core (gift-wraps must share announce topology). */
const MAX_ROUND_RELAYS = FUSION_CORE_RELAYS.length;
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
  /**
   * `auto` = full alone budget (wait for peers). `manual` = short alone abort.
   */
  trigger?: 'auto' | 'manual';
  onStatus?: (message: string) => void;
  onPhase?: (phase: number) => void;
  signal?: AbortSignal;
}

function toPoolNetwork(network: Network): FusionPoolNetwork {
  return network === Network.MAINNET ? 'mainnet' : 'chipnet';
}

/**
 * Fusion always runs on {@link FUSION_CORE_RELAYS}. User/chat extras are ignored
 * for pool discovery so multi-window tests cannot partition on different lists.
 */
function validatedRelays(
  _configured?: string[],
  max = MAX_ANNOUNCE_RELAYS
): string[] {
  const relays = FUSION_CORE_RELAYS.filter((relay) =>
    relay.startsWith('wss://')
  ).slice(0, max);
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
export async function collectRolling(
  walletId: number,
  selfPubkey: string,
  getPeers: () => PoolAnnouncement[],
  onStatus?: (message: string) => void,
  signal?: AbortSignal,
  /** Re-publish when alone so late Tor peers still find us. */
  announceNow?: () => Promise<void>,
  /** Auto waits full alone budget; manual fails faster. */
  trigger: 'auto' | 'manual' = 'manual'
): Promise<PoolAnnouncement[]> {
  const start = Date.now();
  const gatherStartSeconds = Math.floor(start / 1_000);
  const minReady = start + POOL_WAIT_MIN_MS;
  const maxWait = start + POOL_WAIT_MAX_MS;
  const aloneBudgetMs =
    trigger === 'auto' ? P2P_GATHER_ALONE_AUTO_MS : P2P_GATHER_ALONE_MS;
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
    isOwnRoundKey(walletId, pubkey) ||
    isRetiredRoundKey(pubkey) ||
    // Verified protocol-fault keys only — never timeout/lag (see fusionBlame).
    isBlamedSessionKey(pubkey);
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
      // Counts only — never session pubkeys (throwaway keys, but still
      // correlatable across local windows / shared logs).
      console.info(
        `[p2p-fusion] live set strict=${peers.length} soft=${soft.length} peak=${peakStrict}/${peakSoft}`
      );
      void log.info(
        'p2p-live',
        `w${walletId} strict=${peers.length} soft=${soft.length} peak=${peakStrict}/${peakSoft}`
      );
    }
    // Alone or under-count: re-shout often so a lagging Tor peer still finds us.
    // Use MIN/MAX policy constants — not a bare "3".
    // Alone: re-shout every 1.5s so Tor/BC lag does not strand a 120s wait.
    const boostMs = peers.length < MIN_PARTICIPANTS ? 1_500 : 3_000;
    if (
      peers.length < Math.max(MIN_PARTICIPANTS, peakSoft, peakStrict) &&
      announceNow &&
      now - lastAnnounceBoost > boostMs
    ) {
      lastAnnounceBoost = now;
      void announceNow().catch(() => undefined);
    }
    const n = peers.length;
    const atCap = n >= MAX_PARTICIPANTS;
    const enough = n >= MIN_PARTICIPANTS;
    const elapsed = now - start;
    const stableFor = now - stableSince;
    const peakGraceLeft = Math.max(0, P2P_PEAK_GRACE_MS - (now - lastAtPeakMs));
    const peakGraceExpired = peakGraceLeft === 0;
    // Soft lag / peak drop only block EARLY lock for a short grace.
    const expectMoreFromSoft =
      soft.length > peers.length &&
      now - lastSoftCaughtUpMs < P2P_PEAK_GRACE_MS;
    const lostFromPeak =
      peakStrict > peers.length && peakStrict >= MIN_PARTICIPANTS;
    const expectMoreFromPeak = lostFromPeak && !peakGraceExpired;
    // Soft and strict disagree: wait until match or soft-grace expires
    // so one wallet does not propose N while another sees N-1.
    const viewsAligned =
      soft.length === peers.length ||
      now - lastSoftCaughtUpMs >= P2P_PEAK_GRACE_MS;
    const expectMore =
      expectMoreFromSoft || expectMoreFromPeak || !viewsAligned;
    // ── Lock policy (MIN/MAX driven — raise MAX_PARTICIPANTS later without
    // rewriting "4" / "3" branches):
    //   • n >= MAX: fast lock (short warm-up + short stable), no "wait for more"
    //   • MIN <= n < MAX: normal min gather + stable + short hold for more
    //     toward MAX (unless expectMore / peak already equal n)
    //   • n < MIN: never lock early — wait maxWait or alone-after-peak abort
    const pastFastWarmup = elapsed >= P2P_GATHER_FAST_WARMUP_MS;
    const pastMin = elapsed >= POOL_WAIT_MIN_MS;
    const stableNormal = stableFor >= PEER_SET_STABLE_MS;
    const stableFast = stableFor >= P2P_PEER_SET_STABLE_FAST_MS;
    const pastSmallHold = elapsed >= SMALL_SET_HOLD_MS;
    // At cap: we are done growing the set — lock ASAP (still need alignment).
    const fullSetReady = atCap && pastFastWarmup && stableFast && !expectMore;
    // Partial legal set: allow more toward MAX for a short window, then lock.
    const partialSetReady =
      enough &&
      !atCap &&
      pastMin &&
      stableNormal &&
      !expectMore &&
      (n >= peakStrict || pastSmallHold || peakGraceExpired);
    const canLock = fullSetReady || partialSetReady;
    // Live: kept shouting after others fused (peak → alone). Once peak-grace
    // expired with only self left, stop — full JOIN_WAIT is wasted budget.
    if (
      n < MIN_PARTICIPANTS &&
      peakStrict >= 2 &&
      peakGraceExpired &&
      elapsed >= P2P_PEAK_GRACE_MS
    ) {
      throw new Error(
        `No peers left (peak was ${peakStrict}, now only you). ` +
          `Others already fused or left the pool — Cancel is automatic; ` +
          `Auto will retry shortly.`
      );
    }
    // Never found anyone: manual fails fast; auto holds full JOIN_WAIT so
    // peers arriving over Tor can still meet in one gather slot.
    const neverSawOthers = peakSoft <= 1 && peakStrict <= 1;
    if (neverSawOthers && elapsed >= aloneBudgetMs) {
      throw new Error(
        trigger === 'auto'
          ? `Auto: no peers for ${Math.round(aloneBudgetMs / 1000)}s — will retry shortly. ` +
            `Need ≥${MIN_PARTICIPANTS} online with Auto+P2P+Tor; check Nostr relays.`
          : `No other wallets found in ${Math.round(aloneBudgetMs / 1000)}s. ` +
            `Need ≥${MIN_PARTICIPANTS} peers on the same network (Tor + Nostr green). Retry when others are online.`
      );
    }
    // Once this attempt observed a larger strict set, never propose a smaller
    // one. Different wallets otherwise freeze incompatible 4-vs-3 snapshots
    // and rendezvous cannot repair them. Let Auto start a fresh attempt after
    // the membership change instead.
    if (lostFromPeak && (peakGraceExpired || now >= maxWait)) {
      throw new Error(
        `Peer set changed during gather (peak ${peakStrict}, now ${n}). ` +
          `Retrying with a fresh shared set.`
      );
    }
    if (canLock || now >= maxWait) {
      // Never lock a sub-MIN set — anonymity floor and onion mix need ≥3.
      if (n < MIN_PARTICIPANTS) {
        throw new Error(
          trigger === 'auto'
            ? `Auto: only ${n} peer(s) (need ≥${MIN_PARTICIPANTS}). Will retry shortly.`
            : `P2P Fusion needs at least ${MIN_PARTICIPANTS} peers (CashFusion-style anonymity floor).`
        );
      }
      onStatus?.(
        `Gather done: ${n} active wallet(s) ` +
          `(soft ${soft.length}, peak strict/soft ${peakStrict}/${peakSoft}; ` +
          `cap=${MAX_PARTICIPANTS}, stable=${canLock}, ${Math.round(elapsed / 1000)}s).`
      );
      return peers;
    }
    // Status is count-only (no session-pubkey hex). Protocol still uses full
    // keys internally; UI/logs do not need them for gather progress.
    const aloneDeadline = neverSawOthers ? start + aloneBudgetMs : maxWait;
    const secsLeft = Math.max(0, Math.ceil((aloneDeadline - now) / 1_000));
    if (n < 2) {
      const aloneAfterOthers =
        peakStrict >= 2 && peakGraceLeft > 0
          ? ` Peers left (peak ${peakStrict}); giving up in ${Math.ceil(peakGraceLeft / 1000)}s if no one returns…`
          : neverSawOthers
            ? trigger === 'auto'
              ? ` Auto: waiting for peers… (${secsLeft}s, then retry)`
              : ` Shouting on shared relays… (${secsLeft}s then retry if alone)`
            : soft.length > 1 || peakSoft > 1
              ? ' Dropping ghosts; waiting for re-announces…'
              : ' Waiting for other peers (Tor)…';
      onStatus?.(`Only you so far.${aloneAfterOthers}`);
    } else if (n < MIN_PARTICIPANTS) {
      onStatus?.(
        `${n} active — need ≥${MIN_PARTICIPANTS} for P2P (onion privacy); ` +
          `waiting for more peers (${secsLeft}s left)…`
      );
    } else if (atCap) {
      const needStable = Math.max(
        0,
        Math.ceil((P2P_PEER_SET_STABLE_FAST_MS - stableFor) / 1_000)
      );
      const needWarm = Math.max(
        0,
        Math.ceil((P2P_GATHER_FAST_WARMUP_MS - elapsed) / 1_000)
      );
      onStatus?.(
        `${n}/${MAX_PARTICIPANTS} full set — fast lock` +
          (needWarm > 0 ? ` warm ${needWarm}s` : '') +
          (needStable > 0 ? ` stable ${needStable}s` : '') +
          (expectMore ? ' (aligning views…)' : '') +
          '…'
      );
    } else if (enough && pastMin) {
      const needStable = Math.max(
        0,
        Math.ceil((PEER_SET_STABLE_MS - stableFor) / 1_000)
      );
      const holdLeft = Math.max(
        0,
        Math.ceil((SMALL_SET_HOLD_MS - elapsed) / 1_000)
      );
      const holdNote = expectMore
        ? ` waiting up to ${Math.ceil(peakGraceLeft / 1000)}s for peak ${peakStrict}`
        : n < MAX_PARTICIPANTS && holdLeft > 0 && n < peakStrict
          ? ` hold ${holdLeft}s toward ${MAX_PARTICIPANTS}`
          : n < MAX_PARTICIPANTS && holdLeft > 0
            ? ` hold ${holdLeft}s for more (max ${MAX_PARTICIPANTS})`
            : '';
      onStatus?.(`${n} active — ${needStable}s stable${holdNote}…`);
    } else if (enough) {
      const inSecs = Math.max(0, Math.ceil((minReady - now) / 1_000));
      onStatus?.(`${n} active wallet(s) — min gather ${inSecs}s…`);
    } else {
      onStatus?.(`Waiting: ${n} active (up to ${secsLeft}s)…`);
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
export function selectFusionInputs(utxos: UTXO[]): UTXO[] {
  return [...utxos]
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
    .slice(0, MAX_INPUT_CREDENTIALS_PER_PEER);
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
  options?: { preferProvided?: boolean; skipLiveRecheck?: boolean }
): Promise<UTXO[]> {
  if (signal?.aborted) throw new Error('fusion round cancelled');
  const claimed = reservedOutpoints(walletId);
  const nonToken = (list: UTXO[]) =>
    list.filter(
      (utxo) =>
        !utxo.token && !claimed.has(outpointKey(utxo.tx_hash, utxo.tx_pos))
    );

  // Prefer the runner's already-reconciled coins (skip a second exclusive
  // listunspent that blocked multi-wallet P2P on "Refreshing coins…").
  let free = options?.preferProvided ? nonToken(fallbackUtxos) : [];
  if (free.length === 0) {
    const refreshed = await reconcileActiveWalletUtxosForSpend(
      walletId,
      signal
    );
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

  // Multi-wallet Start: exclusive reconcile already verified these. A second
  // onlyUnspent (15s timeout × N windows) stamps Electrum and hangs gather.
  if (options?.skipLiveRecheck && free.length > 0) {
    return free;
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

interface NativeP2pSignResponse {
  protocol: string;
  templateHash: string;
  fee: number;
  signatures: Array<{ outpoint: string; signature: string }>;
}

export interface NativeP2pSignOptions {
  tx: AssembledFusionTx;
  myContribution: PeerContribution;
  keysByPubkey: Map<string, Uint8Array>;
  network: 'mainnet' | 'chipnet';
  session: string;
  participants: string[];
  tier: number;
  feerate: number;
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const size = parts.reduce((total, part) => total + part.length, 0);
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.length;
  }
  return merged;
}

function p2pSigningHashes(options: NativeP2pSignOptions): {
  transcriptHash: string;
  templateHash: string;
} {
  const session = options.session.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(session)) {
    throw new Error('P2P Fusion signing session must be 32-byte hex.');
  }
  const transcript = JSON.stringify({
    protocol: 'p2p-v3',
    network: options.network,
    session,
    tier: options.tier,
    feerate: options.feerate,
    participants: [...options.participants]
      .map((participant) => participant.toLowerCase())
      .sort(),
    inputs: options.tx.inputs.map((input) => ({
      prevTxid: input.prevTxid.toLowerCase(),
      prevIndex: input.prevIndex,
      value: input.value,
      pubkey: input.pubkey.toLowerCase(),
    })),
    outputs: options.tx.outputs.map((output) => ({
      script: output.script.toLowerCase(),
      value: output.value,
    })),
  });
  const transcriptBytes = sha256.hash(new TextEncoder().encode(transcript));
  const unsignedTemplate = encodeTransaction(
    toLibauthTx(options.tx).transaction
  );
  const unsignedTemplateHash = hash256(unsignedTemplate);
  const templateBytes = concatBytes([
    new TextEncoder().encode('OPTN-P2P-FUSION-V3\0'),
    new TextEncoder().encode(options.network),
    Uint8Array.of(0),
    hexToBin(session),
    transcriptBytes,
    unsignedTemplateHash,
  ]);
  return {
    transcriptHash: binToHex(transcriptBytes),
    templateHash: binToHex(sha256.hash(templateBytes)),
  };
}

/**
 * Cross the native P2P-v3 signing boundary only after the renderer has applied
 * its independent safety check. Rust rebuilds the complete template, repeats
 * exact owned input/output and fee checks, and returns signatures only for the
 * wallet-owned outpoints.
 */
export async function nativeSignP2pInputs(
  options: NativeP2pSignOptions
): Promise<InputSig[]> {
  const hashes = p2pSigningHashes(options);
  const txByOutpoint = new Map(
    options.tx.inputs.map((input) => [
      `${input.prevTxid.toLowerCase()}:${input.prevIndex}`,
      input,
    ])
  );
  const keyBuffers: Uint8Array[] = [];
  const ownedInputs = options.myContribution.inputs.map((input) => {
    const outpoint = `${input.prevTxid.toLowerCase()}:${input.prevIndex}`;
    const actual = txByOutpoint.get(outpoint);
    if (
      !actual ||
      actual.value !== input.value ||
      actual.pubkey.toLowerCase() !== input.pubkey.toLowerCase()
    ) {
      throw new Error('P2P Fusion template changed a wallet-owned input.');
    }
    const privateKey = options.keysByPubkey.get(input.pubkey);
    if (!privateKey || privateKey.length !== 32) {
      throw new Error('P2P Fusion native signer is missing an owned key.');
    }
    keyBuffers.push(privateKey);
    return {
      prevTxid: input.prevTxid.toLowerCase(),
      prevIndex: input.prevIndex,
      pubkey: input.pubkey.toLowerCase(),
      value: input.value,
      privateKey: binToHex(privateKey),
    };
  });
  const requiredFee = minimumFee(options.tx, options.feerate);
  const request = {
    protocol: 'p2p-v3',
    network: options.network,
    session: options.session.toLowerCase(),
    transcriptHash: hashes.transcriptHash,
    templateHash: hashes.templateHash,
    inputs: options.tx.inputs.map((input) => ({
      prevTxid: input.prevTxid.toLowerCase(),
      prevIndex: input.prevIndex,
      pubkey: input.pubkey.toLowerCase(),
      value: input.value,
    })),
    outputs: options.tx.outputs.map((output) => ({
      script: output.script.toLowerCase(),
      value: output.value,
    })),
    ownedInputs,
    ownedOutputs: options.myContribution.outputs.map((output) => ({
      script: output.script.toLowerCase(),
      value: output.value,
    })),
    feerate: options.feerate,
    maxFee: requiredFee * 3,
  };

  let response: NativeP2pSignResponse;
  try {
    response = await invoke<NativeP2pSignResponse>('fusion_p2p_sign', {
      request,
    });
  } finally {
    for (const owned of request.ownedInputs) owned.privateKey = '';
    for (const key of keyBuffers) key.fill(0);
  }
  if (
    response.protocol !== 'p2p-v3' ||
    response.templateHash.toLowerCase() !== hashes.templateHash ||
    !Number.isSafeInteger(response.fee) ||
    !Array.isArray(response.signatures)
  ) {
    throw new Error('Native P2P Fusion signer returned an invalid response.');
  }
  const nativeByOutpoint = new Map<string, string>();
  for (const signature of response.signatures) {
    const outpoint = signature.outpoint.toLowerCase();
    if (
      nativeByOutpoint.has(outpoint) ||
      !/^[0-9a-f]{128}$/i.test(signature.signature)
    ) {
      throw new Error('Native P2P Fusion signer returned invalid signatures.');
    }
    nativeByOutpoint.set(outpoint, signature.signature.toLowerCase());
  }
  return options.myContribution.inputs.map((input) => {
    const outpoint = `${input.prevTxid.toLowerCase()}:${input.prevIndex}`;
    const signature = nativeByOutpoint.get(outpoint);
    if (!signature || nativeByOutpoint.size !== ownedInputs.length) {
      throw new Error('Native P2P Fusion signer omitted an owned input.');
    }
    return {
      prevTxid: input.prevTxid,
      prevIndex: input.prevIndex,
      unlockingBytecode: `41${signature}4121${input.pubkey.toLowerCase()}`,
    };
  });
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

/**
 * Production P2P broadcast route. Both the BCH relay and every independent
 * visibility lookup are performed by native code through the already-verified
 * Tor proxy; no renderer Electrum socket is used as a privacy fallback.
 */
export async function broadcastP2pTransactionTorOnly(
  txHex: string,
  network: Network,
  tor: { host: string; port: number }
): Promise<P2pBroadcastReceipt> {
  const expectedTxid = binToHex(hash256(hexToBin(txHex)).reverse());
  const relay = defaultRelayEndpoints(network);
  let relaySubmitted = false;
  try {
    const observation = await invoke<FusionRelayObservation>(
      'fusion_relay_broadcast_and_observe',
      {
        txHex,
        network,
        ...relay,
        torHost: tor.host,
        torPort: tor.port,
      }
    );
    if (observation.txid.toLowerCase() !== expectedTxid) {
      throw new Error('Tor relay returned a different transaction id.');
    }
    relaySubmitted = observation.relaySubmitted;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      DEFINITIVE_BROADCAST_REJECTIONS.some((pattern) => pattern.test(message))
    ) {
      throw new Error(`Fusion broadcast rejected: ${message}`);
    }
    // The relay may have accepted the bytes before its response was lost.
    // Resolve that ambiguity only through the Tor-routed native lookup below.
  }
  // On BCH, 0-conf is standard. A relay that accepted the bytes (relaySubmitted)
  // is sufficient confirmation — the tx WILL propagate. The observer may just be
  // slow; no need to gate "Fused" on a second network lookup.
  if (relaySubmitted) {
    return { txid: expectedTxid, verified: true };
  }

  // Relay status unknown (response lost / exception). Verify via network lookup.
  const [lookup, ...fallbacks] = inputLookupEndpoints(network);
  const seen = await invoke<boolean>('fusion_transaction_is_known', {
    txid: expectedTxid,
    lookupHost: lookup.host,
    lookupPort: lookup.port,
    lookupUseSsl: lookup.useSsl,
    lookupFallbacks: fallbacks,
    torHost: tor.host,
    torPort: tor.port,
  }).catch(() => false);
  if (seen) return { txid: expectedTxid, verified: true };

  return {
    txid: expectedTxid,
    verified: false,
    warning:
      'Broadcast was sent over Tor, but independent network visibility is still pending. The signed transaction remains reserved while wallet sync verifies it.',
  };
}

/** Run one P2P round on the active BCH network. */
export async function runP2pFusion(
  opts: P2pFusionOptions
): Promise<RoundResult & { warning?: string; verificationPending?: boolean }> {
  if (!isFusionExecutionAllowed())
    throw new Error('P2P fusion execution is paused.');
  if (!opts.tor) {
    throw new Error(
      'Tor is required for P2P fusion — enable Tor and wait for bootstrap.'
    );
  }
  if (opts.signal?.aborted) throw new Error('fusion round cancelled');

  const status = opts.onStatus;
  status?.('Checking Tor…');
  const torOk = await invoke<boolean>('fusion_tor_check', {
    host: opts.tor.host,
    port: opts.tor.port,
  });
  if (opts.signal?.aborted) throw new Error('fusion round cancelled');
  if (!torOk) throw new Error('Tor is not reachable — P2P fusion stopped.');

  // Shared proven core only (see FUSION_CORE_RELAYS) — not full chat bootstrap.
  const announceRelays = validatedRelays(opts.relays, MAX_ANNOUNCE_RELAYS);
  const roundRelays = announceRelays.slice(0, MAX_ROUND_RELAYS);
  const relays = announceRelays;
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
  // Declared beside the reservation they gate, because the `finally` that
  // releases it lives outside the try block that performs the broadcast.
  //
  // Three states, not two. A round that never reached the relay must free its
  // coins (otherwise a failed round strands them until the TTL). A round proven
  // independently visible must free them (they are spent). A round that reached
  // the relay with an unresolved outcome must NOT — those bytes may be live, and
  // reselecting the inputs would build a conflicting spend against our own
  // possibly-confirming CoinJoin.
  let broadcastAttempted = false;
  let broadcastVerified = false;
  let broadcastRejected = false;
  let withdrawFromPool: (() => Promise<void>) | null = null;

  try {
    releaseTorRouting = armTorRouting({
      host: opts.tor.host,
      port: opts.tor.port,
    });
    // Runner already did exclusive listunspent. Use those coins — a second
    // Electrum onlyUnspent stampede on 4 windows is what made Start die with
    // "All Electrum servers failed" / hang after "Using N coin(s)".
    status?.('Preparing coins for this round…');
    const spendable = selectFusionInputs(
      await refreshAndVerifyP2pInputs(opts.walletId, opts.utxos, opts.signal, {
        preferProvided: true,
        skipLiveRecheck: true,
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
    // Soft first announce: one relay blip must not abort before gather.
    // collectRolling keeps re-shouting; we only surface a warning if all retries fail.
    let announceOk = false;
    for (let i = 0; i < 3 && !announceOk; i++) {
      try {
        await joined.announceNow();
        announceOk = true;
      } catch (error) {
        if (opts.signal?.aborted) throw error;
        if (i === 2) {
          status?.(
            `First pool announce flaky (${error instanceof Error ? error.message : String(error)}). ` +
              `Still collecting peers — will re-shout…`
          );
        } else {
          await new Promise((r) => setTimeout(r, 500 * (i + 1)));
        }
      }
    }
    opts.onPhase?.(1);
    status?.(
      announceOk
        ? 'Pool announcement published; collecting peers (loading signing keys in background)…'
        : 'Pool announce delayed (relays slow); collecting peers and re-shouting…'
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
        () => joined.announceNow(),
        opts.trigger ?? 'manual'
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
        `No P2P peers found (only ${fresh.length} live wallet(s); need ≥${MIN_PARTICIPANTS} wallets ` +
          `on ${network} with Tor + P2P on, starting around the same time). ` +
          `CashFusion-style privacy needs at least 3 peers (onion mix).`
      );
    }
    status?.(
      `Proposing ${group.participants.length} active wallet(s) at ${group.tier} sats ` +
        `(gathered ${fresh.length}). Waiting for every proposed wallet to ACK — ` +
        `this is what keeps all ${group.participants.length} in the same round…`
    );

    const transport = createNostrRoundTransport(
      pool,
      roundRelays,
      round,
      outputPool,
      opts.signal,
      // Production only. The Tor WebSocket implementation is installed globally
      // (setNostrWebSocketImpl), so each new pool opens a new connection and
      // therefore a new Tor circuit — the relay cannot group this round's
      // outputs by socket the way it could when they shared outputPool.
      () => new SimplePool()
    );
    // Brief wire-up so onMessage (Nostr + same-origin BC) is subscribed before
    // the elected coordinator's first proposal (live: silent-coordinator failover
    // when all three locked gather within 1s but listeners were not ready).
    await new Promise((r) => setTimeout(r, 400));
    if (opts.signal?.aborted) throw new Error('fusion round cancelled');
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
          `Could not agree on a round (${group.participants.length} peers). ` +
            `Peers may have timed out or left — Auto will retry; check Tor + relays.`
        );
      }
      throw error;
    } finally {
      joined.stop();
      stopPool = null;
    }
    // Belt-and-suspenders: rendezvous must never return a shrunk set (2-of-4
    // "Continuing…" left late peers alone — not acceptable).
    if (negotiated.participants.length < group.participants.length) {
      throw new Error(
        `Round shrank to ${negotiated.participants.length}/${group.participants.length} ` +
          `wallets — refusing partial fuse. Auto will retry; full set must stay.`
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
        network: toPoolNetwork(opts.network),
        tier: negotiated.tier,
        feerate: P2P_FEERATE,
        myContribution: { inputs: myInputs, outputs: myOutputs },
        keysByPubkey,
        sign: (tx) =>
          nativeSignP2pInputs({
            tx,
            myContribution: { inputs: myInputs, outputs: myOutputs },
            keysByPubkey,
            network: toPoolNetwork(opts.network),
            session: negotiated.session,
            participants: negotiated.participants,
            tier: negotiated.tier,
            feerate: P2P_FEERATE,
          }),
        // Onion is always on (rounds are ≥3 peers; no 2-party / direct path).
        // ≤ server T_START_CLOSE_BLAME; tight jitter so inject fits comps window.
        timeoutMs: P2P_ROUND_TIMEOUT_MS,
        jitterMs: P2P_COMPONENT_JITTER_MS,
        signal: opts.signal,
        onStatus: status,
        onBlame: (report) => {
          recordBlamedSessionKey(report.accused);
          status?.(
            `Recorded protocol fault (${report.code}) — ` +
              `excluded that session key only, not a person ban.`
          );
        },
        broadcast: async (txHex) => {
          const expectedTxid = binToHex(hash256(hexToBin(txHex)).reverse());
          try {
            const tracked = await OutboundTransactionTracker.trackAttempt({
              walletId: opts.walletId,
              rawTx: txHex,
              spentInputs: spendable,
              source: 'p2p-fusion',
              sourceLabel: 'P2P Fusion',
              privacyRoute: 'tor-only',
            });
            if (!tracked || tracked.txid.toLowerCase() !== expectedTxid) {
              throw new Error(
                'The signed P2P Fusion transaction could not be reserved before relay.'
              );
            }
            broadcastAttempted = true;
            const receipt = await broadcastP2pTransactionTorOnly(
              txHex,
              opts.network,
              opts.tor!
            );
            broadcastWarning = receipt.warning;
            // An unverified receipt means the bytes may or may not be live. The
            // receipt promises the inputs stay reserved; honour that here so the
            // `finally` below cannot hand these coins to the next round while a
            // possibly-live transaction still spends them.
            broadcastVerified = receipt.verified;
            if (!receipt.verified) {
              await OutboundTransactionTracker.markVerificationPending(
                expectedTxid,
                receipt.warning ??
                  'Fusion broadcast visibility is still being verified.',
                opts.walletId
              );
            }
            return receipt.txid;
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            if (message.startsWith('Fusion broadcast rejected:')) {
              broadcastRejected = true;
              await OutboundTransactionTracker.remove(
                expectedTxid,
                opts.walletId
              ).catch(() => undefined);
            }
            // A rejected CoinJoin does not identify which input became stale.
            // Re-check our own inputs so the user gets a useful, bounded verdict
            // without writing the raw transaction or wallet outpoints to logs.
            const survivors = await onlyUnspent(spendable, opts.signal).catch(
              () => null
            );
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
    const completion = broadcastVerified
      ? await completeFusionBroadcast({
          walletId: opts.walletId,
          txid: result.txid,
          txHex: result.txHex,
          spentInputs: spendable,
          source: 'p2p-fusion',
          sourceLabel: 'P2P Fusion',
          // Same as server fusion: round already ran over Tor; do not re-announce the
          // CoinJoin via ordinary Electrum observe. Depth / history / UTXO refresh
          // still run in completeFusionBroadcast for labels and Auto stop.
          privacyRoute: 'tor-only',
          // The scripts we allocated for ourselves this round. The completion layer
          // resolves them to txid:index — a round shuffles its outputs so position
          // carries no information, and guessing an index here would eventually
          // credit a peer's coin to us.
          ownedOutputScripts: outputScripts,
        })
      : null;
    const warning = [
      broadcastWarning,
      completion ? fusionCompletionWarning(completion) : undefined,
    ]
      .filter((message): message is string => Boolean(message))
      .join(' ');
    // Only claim a completed fusion when the CoinJoin was independently seen.
    // "Fused ✓" on an unresolved broadcast tells the user the round is done and
    // their coins are spent, when in fact nothing on the network confirms that.
    status?.(
      !broadcastVerified
        ? `Fusion pending — txid ${result.txid}. ${warning || 'Awaiting network visibility; inputs stay reserved until sync confirms.'}`
        : warning
          ? `Fused ✓ — txid ${result.txid}. ${warning}`
          : `Fused ✓ — txid ${result.txid}`
    );
    if (!broadcastVerified) {
      return {
        ...result,
        verificationPending: true,
        ...(warning.length > 0 ? { warning } : {}),
      };
    }
    return warning.length > 0 ? { ...result, warning } : result;
  } finally {
    // Free the coins only when their fate is known. A round that never reached
    // the relay must not strand them; a round proven visible has already spent
    // them and the live re-check keeps them out next time. An AMBIGUOUS
    // broadcast is neither: the receipt told the user "remains reserved while
    // wallet sync verifies it", and releasing here would break that promise and
    // let the next round build a conflicting spend against a CoinJoin that may
    // already be confirming. Leave the lock for the stored TTL to expire, or for
    // wallet sync to resolve the transaction first.
    if (!broadcastAttempted || broadcastVerified || broadcastRejected) {
      releaseOutpoints(opts.walletId, reservedForRound);
    } else {
      console.warn(
        '[p2p-fusion] broadcast unresolved — keeping %d input reservation(s) until sync confirms',
        reservedForRound.length
      );
    }
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
