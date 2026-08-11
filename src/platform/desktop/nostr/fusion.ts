// P2P CashFusion pool discovery over Nostr.
//
// Discovery uses a fresh secp256k1 identity for every attempt (the 00-Wallet
// scheme), never the wallet/chat identity. Public announcements are a REPLACEABLE
// kind scoped to one network (rolling pool, no epoch bucket). Their signature,
// tags, timestamp, freshness, protocol version, tier list, and component counts
// are all validated before a peer enters a candidate set; the client-side
// freshness window prevents a relay's store from resurrecting dead identities.

import {
  SimplePool,
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  verifyEvent,
  type Event,
} from 'nostr-tools';

import { isRetiredRoundKey, retireRoundKey } from '../fusionRoundState';

// Public ready announcement. A NIP-01 REPLACEABLE kind (10000-19999): the relay
// keeps only the latest event per throwaway pubkey and REPLAYS it to any new
// subscriber via the `since` filter. Ephemeral kinds (20000-29999, e.g. the
// 00-Wallet's 22230) are never stored or replayed, so a peer that connects to a
// relay over Tor AFTER another peer's broadcast never sees it — discovery then
// silently fails (rx stays at self). Replaceable + `since` makes a late-joining
// Tor subscriber immediately learn everyone already waiting in the rolling pool.
export const POOL_ANNOUNCE_KIND = 12230;
/** Reserved coordination kind. Private round traffic uses NIP-59 kind 1059. */
export const ROUND_MESSAGE_KIND = 22231;
export const FUSION_POOL_PROTOCOL = 1;

/** Globally aligned windows remove the old per-client 60-second snapshot race. */
export const POOL_EPOCH_SECONDS = 30;
export const POOL_EPOCH_GRACE_SECONDS = 8;
// Keep first announce quick so 4 wallets that click Start together discover
// each other before any of them lock a smaller set and leave gather.
export const MAX_ANNOUNCE_DELAY_MS = 800;
// The announcement is a stored replaceable event, so the relay keeps serving the
// latest one to new subscribers — frequent re-announcing buys nothing and made
// relays answer "rate-limited: you are noting too much". Refresh slowly, just
// often enough to stay inside the peer-active window.
// Faster refresh during multi-wallet gather so asymmetric Tor views converge.
// 4s: under Tor, missing one or two cycles is common; stay inside the live window.
const REANNOUNCE_MS = 4_000;
/** Public re-announce period (seconds). Live gatherers republish on this cadence. */
export const POOL_REANNOUNCE_SECONDS = REANNOUNCE_MS / 1_000;
/**
 * How long a peer stays "live" after we last heard them (or after their event
 * created_at). Must cover several missed re-announce cycles over Tor — 10s was
 * so tight that multi-wallet gather collapsed to "1 live wallet" (self only).
 */
export const POOL_LIVE_ACTIVE_SECONDS = 24;
/**
 * How far back the pool subscription pulls replaceable announces.
 * 60s was short when Tor connect + announce retries took 30–90s — late
 * subscribers never saw early wallets. 180s matches POOL_PEER_TTL.
 */
export const POOL_SUBSCRIBE_LOOKBACK_SECONDS = 180;
const MAX_FUTURE_SKEW_SECONDS = 5;
const MAX_ANNOUNCEMENT_BYTES = 2_048;
const MAX_TIERS = 16;
const MAX_INPUTS = 20;
const MAX_TOTAL_COMPONENTS = 120;
const MAX_OUTPUTS_PER_PEER = 6;

// ─── Gathering model: 3–8 peers (CashFusion-style anonymity floor) ─────
/** Maximum participants per round (onion mix-net cap). */
export const MAX_PARTICIPANTS = 8;
/**
 * Minimum participants to start a P2P round.
 * CashFusion server pools start well above 2 (reference min_clients is often 8);
 * privacy-wise 2-party is barely a CoinJoin. Onion mix needs ≥2 peelers ⇒ ≥3
 * wallets. Match that floor: never start P2P with only a pair.
 */
export const MIN_PARTICIPANTS = 3;
/** How long to wait for peers to gather before starting with whoever we have. */
export const GATHER_TIMEOUT_MS = 30_000;

export type FusionPoolNetwork = 'mainnet' | 'chipnet';

export function poolEpoch(nowSeconds = Math.floor(Date.now() / 1000)): number {
  return Math.floor(nowSeconds / POOL_EPOCH_SECONDS);
}

export function poolEpochStart(epoch: number): number {
  return epoch * POOL_EPOCH_SECONDS;
}

export function poolEpochEnd(epoch: number): number {
  return poolEpochStart(epoch) + POOL_EPOCH_SECONDS;
}

/** One public ROLLING pool per NETWORK (not per-epoch). Peers announcing at any
 *  time within the freshness window discover each other — no synchronized clicks
 *  (the 00-Wallet model). Compatible tiers are carried in content. */
export function poolTag(network: FusionPoolNetwork): string {
  return `optn-fusion-v${FUSION_POOL_PROTOCOL}-${network}`;
}

/** How long an announcement stays fresh/discoverable (rolling TTL, seconds).
 *  v1.7.0 used 180. HEAD briefly used 30 then 60 — too short for multi-wallet
 *  Tor startup: late subscribers never re-fetched peers that had already
 *  stopped re-announcing after forming a 2-of-3 group. */
export const POOL_PEER_TTL_SECONDS = 180;

export interface RoundIdentity {
  secretKey: Uint8Array;
  pubkey: string;
}

export function generateRoundIdentity(): RoundIdentity {
  const secretKey = generateSecretKey();
  return { secretKey, pubkey: getPublicKey(secretKey) };
}

export interface PoolAnnouncement {
  pubkey: string;
  network: FusionPoolNetwork;
  epoch: number;
  tiers: number[];
  numInputs: number;
  /** Event `created_at` (author clock). */
  at: number;
  expiresAt: number;
  /**
   * Local wall time (seconds) we last received this pubkey from a relay.
   * Tor often drops re-announce events; without this, a single delivered
   * announce ages out of the live set and gather falls to "1 live wallet".
   */
  seenAt?: number;
}

/**
 * Decide whether a pool announcement is a live gatherer for THIS attempt.
 *
 * Ghost overcount (4 wallets → "7 peers") vs undercount ("1 live wallet") both
 * come from throwaway keys + Tor lag. Rules:
 *   1) Drop own/retired ghosts.
 *   2) Keep anyone we heard recently (`seenAt` or `at` within live window).
 *   3) After a few re-announce cycles, also require fresh `created_at` so a
 *      one-shot relay replay of an abandoned Start key ages out — live peers
 *      keep refreshing `created_at` every {@link POOL_REANNOUNCE_SECONDS}.
 */
export function isLivePoolAnnouncement(
  peer: Pick<PoolAnnouncement, 'pubkey' | 'at' | 'expiresAt' | 'seenAt'>,
  opts: {
    nowSeconds: number;
    gatherStartSeconds: number;
    selfPubkey: string;
    /** Own abandoned keys + retired keys. */
    isGhostKey: (pubkey: string) => boolean;
    /**
     * When true (gather lock / propose), only peers that re-published during
     * THIS gather count. Stored ghosts stop re-announcing; live wallets refresh
     * every {@link POOL_REANNOUNCE_SECONDS}. Fixes 2-of-4 fuse from proposing 6.
     */
    lockStrict?: boolean;
  }
): boolean {
  if (peer.pubkey === opts.selfPubkey) return true;
  if (opts.isGhostKey(peer.pubkey)) return false;
  if (peer.expiresAt < opts.nowSeconds) return false;

  const lastHeard = peer.seenAt ?? peer.at;
  if (lastHeard < opts.nowSeconds - POOL_LIVE_ACTIVE_SECONDS) return false;

  const elapsed = opts.nowSeconds - opts.gatherStartSeconds;
  // Strict lock: created_at AND hear-time must be from THIS gather. Relay
  // replay of a stored announce can refresh seenAt on subscribe while at is
  // old — or a dead re-announce loop can keep at fresh while we never hear
  // them again. Both must pass so auto does not propose ghosts (live: w1
  // proposed 3 while w5/w6 stayed alone).
  if (opts.lockStrict) {
    return (
      peer.at >= opts.gatherStartSeconds - 3 &&
      lastHeard >= opts.gatherStartSeconds - 3
    );
  }
  // After ~1 re-announce cycle, demand re-publish during this gather so
  // abandoned Starts (static created_at) drop faster (ghost soft inflation).
  // Tor lag still allows live peers who refresh every POOL_REANNOUNCE_SECONDS.
  if (elapsed >= POOL_REANNOUNCE_SECONDS) {
    return peer.at >= opts.gatherStartSeconds - 3;
  }
  return true;
}

export interface BuildPoolAnnouncementOptions {
  network: FusionPoolNetwork;
  /**
   * Epoch to stamp. Omit in production — it is derived from the announcement's
   * own clock so a long-lived session never publishes a stale bucket. Pass one
   * only to pin a value deliberately (tests).
   */
  epoch?: number;
  tiers: number[];
  numInputs: number;
  nowSeconds?: number;
}

function validTier(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 10_000 &&
    value <= 21_000_000 * 100_000_000
  );
}

function normalizeTiers(tiers: number[]): number[] {
  return Array.from(new Set(tiers.filter(validTier))).sort((a, b) => a - b);
}

export interface BuildPoolAnnouncementOptionsWithdrawn
  extends BuildPoolAnnouncementOptions {
  /** Publish an already-expired announcement so peers drop us immediately. */
  withdraw?: boolean;
}

export function buildPoolAnnouncement(
  round: RoundIdentity,
  options: BuildPoolAnnouncementOptionsWithdrawn
): Event {
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tiers = normalizeTiers(options.tiers);
  if (tiers.length === 0 || tiers.length > MAX_TIERS) {
    throw new Error('P2P Fusion announcement needs 1-16 valid tiers.');
  }
  if (
    !Number.isSafeInteger(options.numInputs) ||
    options.numInputs < 1 ||
    options.numInputs > MAX_INPUTS
  ) {
    throw new Error('P2P Fusion announcement has an invalid input count.');
  }
  // Withdrawal: already-expired so peers drop us. Live: discoverable for TTL.
  // Content + NIP-40 tag (relays that honor expiration can delete; clients that
  // only read content still drop via parsePoolAnnouncement). Without the tag,
  // abandoned Start keys stay on the relay forever (Claude: replaceable is per
  // pubkey, and each Start mints a new key → no replacement, only accumulation).
  const expiresAt = options.withdraw ? now - 1 : now + POOL_PEER_TTL_SECONDS;
  // Stamped from `now`, NOT from a value captured when the pool was joined.
  // `joinPool` holds one `options.epoch` for the whole session and a session
  // outlives many 30s buckets, so a frozen stamp would make every honest
  // re-announce look a bucket stale the moment a verifier started checking it.
  // Callers may still pin one explicitly (tests, and the withdraw path).
  const epoch = options.epoch ?? poolEpoch(now);
  const content = JSON.stringify({
    protocol: FUSION_POOL_PROTOCOL,
    network: options.network,
    epoch,
    tiers,
    numInputs: options.numInputs,
    expiresAt,
  });

  return finalizeEvent(
    {
      kind: POOL_ANNOUNCE_KIND,
      created_at: now,
      tags: [
        ['t', poolTag(options.network)],
        ['n', options.network],
        ['v', String(FUSION_POOL_PROTOCOL)],
        // NIP-40 — unix seconds as string
        ['expiration', String(expiresAt)],
      ],
      content,
    },
    round.secretKey
  );
}

export interface ParsePoolAnnouncementScope {
  network: FusionPoolNetwork;
  epoch: number;
  nowSeconds?: number;
}

function hasTag(evt: Event, name: string, value: string): boolean {
  return evt.tags.some((tag) => tag[0] === name && tag[1] === value);
}

/** Validate before admitting a relay event to the active candidate set. */
export function parsePoolAnnouncement(
  evt: Event,
  scope: ParsePoolAnnouncementScope
): PoolAnnouncement | null {
  const now = scope.nowSeconds ?? Math.floor(Date.now() / 1000);
  // nostr-tools memoizes verification on the event object. Verify a clean copy
  // so a mutated/reused object can never inherit a prior successful cache bit.
  const eventForVerification: Event = {
    id: evt.id,
    pubkey: evt.pubkey,
    created_at: evt.created_at,
    kind: evt.kind,
    tags: evt.tags.map((tag) => [...tag]),
    content: evt.content,
    sig: evt.sig,
  };
  if (
    evt.kind !== POOL_ANNOUNCE_KIND ||
    evt.content.length > MAX_ANNOUNCEMENT_BYTES ||
    !verifyEvent(eventForVerification) ||
    evt.created_at > now + MAX_FUTURE_SKEW_SECONDS ||
    evt.created_at < now - POOL_PEER_TTL_SECONDS - MAX_FUTURE_SKEW_SECONDS ||
    !hasTag(evt, 't', poolTag(scope.network)) ||
    !hasTag(evt, 'n', scope.network) ||
    !hasTag(evt, 'v', String(FUSION_POOL_PROTOCOL))
  ) {
    return null;
  }

  try {
    const content = JSON.parse(evt.content) as Record<string, unknown>;
    const tiers = Array.isArray(content.tiers)
      ? normalizeTiers(content.tiers as number[])
      : [];
    const expiresAt = Number(content.expiresAt);
    const numInputs = Number(content.numInputs);
    const declaredEpoch = Number(content.epoch);
    // The announcer SIGNED this bucket, so a relay replaying an abandoned Start
    // cannot advance it — unlike `created_at` freshness, which cannot tell a
    // stored ghost from an honest peer whose re-announce Tor delivered late.
    // Both look like "an old timestamp", which is why tightening that window
    // caused undercount and loosening it caused ghosts; it is not a decidable
    // test. This one is: a live peer republishes every few seconds and always
    // carries the current bucket, so one bucket of grace absorbs any delivery
    // lag while bounding a ghost's life to at most 2 * POOL_EPOCH_SECONDS.
    const currentEpoch = poolEpoch(now);
    if (
      content.protocol !== FUSION_POOL_PROTOCOL ||
      content.network !== scope.network ||
      tiers.length === 0 ||
      tiers.length > MAX_TIERS ||
      !Number.isSafeInteger(numInputs) ||
      numInputs < 1 ||
      numInputs > MAX_INPUTS ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt < now ||
      !Number.isSafeInteger(declaredEpoch) ||
      declaredEpoch > currentEpoch ||
      declaredEpoch < currentEpoch - 1
    ) {
      return null;
    }
    return {
      pubkey: evt.pubkey,
      network: scope.network,
      // The announcer's own bucket, not the verifier's. Reporting the local
      // scope here hid exactly the staleness this check now enforces.
      epoch: declaredEpoch,
      tiers,
      numInputs,
      at: evt.created_at,
      expiresAt,
    };
  } catch {
    return null;
  }
}

export interface FusionGroupPeer {
  pubkey: string;
  tiers: number[];
  numInputs: number;
}

/**
 * Prefer the tier with the largest anonymity set; on equal-sized sets, prefer
 * the larger tier. Participant order is canonical for coordinator election.
 */
export function selectFusionGroup(
  announcements: FusionGroupPeer[],
  minParticipants: number,
  maxParticipants: number
): { tier: number; participants: string[] } | null {
  const byPubkey = new Map<string, FusionGroupPeer>();
  for (const peer of announcements) {
    if (!peer.pubkey || byPubkey.has(peer.pubkey)) continue;
    const tiers = normalizeTiers(peer.tiers);
    if (
      tiers.length === 0 ||
      !Number.isSafeInteger(peer.numInputs) ||
      peer.numInputs < 1 ||
      peer.numInputs > MAX_INPUTS
    ) {
      continue;
    }
    byPubkey.set(peer.pubkey, { ...peer, tiers });
  }
  const peers = [...byPubkey.values()];
  const tiers = Array.from(new Set(peers.flatMap((peer) => peer.tiers))).sort(
    (a, b) => b - a
  );
  let best: { tier: number; participants: string[] } | null = null;
  for (const tier of tiers) {
    const compatible = peers
      .filter((peer) => peer.tiers.includes(tier))
      .sort((a, b) => a.pubkey.localeCompare(b.pubkey));
    const participants: string[] = [];
    let worstCaseComponents = 0;
    for (const peer of compatible) {
      if (participants.length >= Math.max(0, maxParticipants)) break;
      const withPeer =
        worstCaseComponents + peer.numInputs + MAX_OUTPUTS_PER_PEER;
      if (withPeer > MAX_TOTAL_COMPONENTS) continue;
      participants.push(peer.pubkey);
      worstCaseComponents = withPeer;
    }
    if (participants.length < minParticipants) continue;
    if (
      !best ||
      participants.length > best.participants.length ||
      (participants.length === best.participants.length && tier > best.tier)
    ) {
      best = { tier, participants };
    }
  }
  return best;
}

/**
 * Per-relay ACK wait. Was 30s + Promise.allSettled (waited for EVERY relay,
 * including silent ones) → one hung relay delayed success even after another
 * already said OK, and under Tor multi-window load often timed everyone out.
 * 12s is enough for slow Tor; min-ACK race (see publishRaceMinOk).
 */
export const PUBLISH_RELAY_TIMEOUT_MS = 12_000;
/** Whole-event retries when every relay fails/times out (live: intermittent ACK). */
const PUBLISH_MAX_ROUNDS = 3;
const PUBLISH_RETRY_BASE_MS = 400;
/**
 * Pool discovery must land on *shared* relays. first-OK alone (minAcks=1) let
 * four local wallets each ACK a different flaky relay and never see each other
 * → full 120s "Only you" gather. Require 2 ACKs for announces when ≥2 relays.
 * Round gift-wraps stay at 1 (speed; hops use the shared prefix list).
 */
const PUBLISH_POOL_MIN_ACKS = 2;

function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('fusion round cancelled'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('fusion round cancelled'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Publish once: resolve when `minAcks` relays ACK (do not wait for stragglers).
 * Reject when remaining relays cannot still reach minAcks.
 */
function publishRaceMinOk(
  pool: SimplePool,
  relays: string[],
  event: Event,
  minAcks: number,
  signal?: AbortSignal
): Promise<void> {
  const need = Math.max(1, Math.min(minAcks, relays.length));
  return new Promise((resolve, reject) => {
    let settled = false;
    let remaining = relays.length;
    let oks = 0;
    const errors: unknown[] = [];
    const finishOk = () => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const finishErr = (error: unknown) => {
      errors.push(error);
      remaining -= 1;
      if (settled) return;
      // Still possible to hit need if remaining successes can fill the gap.
      if (oks + remaining >= need) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      const first = errors[0];
      reject(
        first instanceof Error
          ? first
          : new Error(String(first ?? 'relay publish failed'))
      );
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      reject(new Error('fusion round cancelled'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }

    const attempts = pool.publish(relays, event);
    for (let i = 0; i < attempts.length; i++) {
      const attempt = attempts[i];
      let done = false;
      const timer = setTimeout(() => {
        if (done || settled) return;
        done = true;
        finishErr(new Error('relay did not acknowledge in time'));
      }, PUBLISH_RELAY_TIMEOUT_MS);
      attempt.then(
        () => {
          if (done || settled) return;
          done = true;
          clearTimeout(timer);
          oks += 1;
          remaining -= 1;
          if (oks >= need) finishOk();
        },
        (error: unknown) => {
          if (done || settled) return;
          done = true;
          clearTimeout(timer);
          finishErr(error);
        }
      );
    }
  });
}

export async function publishEventAtLeastOnce(
  pool: SimplePool,
  relays: string[],
  event: Event,
  signal?: AbortSignal,
  /** How many distinct relay ACKs before success (default 1 = first-OK). */
  minAcks = 1
): Promise<void> {
  if (relays.length === 0) throw new Error('No Nostr relays configured.');
  if (signal?.aborted) throw new Error('fusion round cancelled');

  let lastError: unknown;
  for (let round = 0; round < PUBLISH_MAX_ROUNDS; round++) {
    if (signal?.aborted) throw new Error('fusion round cancelled');
    try {
      await publishRaceMinOk(pool, relays, event, minAcks, signal);
      return;
    } catch (error) {
      lastError = error;
      if (
        error instanceof Error &&
        error.message === 'fusion round cancelled'
      ) {
        throw error;
      }
      if (round + 1 < PUBLISH_MAX_ROUNDS) {
        await sleepMs(PUBLISH_RETRY_BASE_MS * (round + 1), signal);
      }
    }
  }
  throw new Error(
    `No Nostr relay accepted the Fusion message: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  );
}

export interface JoinPoolOptions {
  round: RoundIdentity;
  network: FusionPoolNetwork;
  epoch: number;
  tiers: number[];
  numInputs: number;
  signal?: AbortSignal;
  onPeer: (peers: PoolAnnouncement[]) => void;
  onError?: (error: Error) => void;
}

/**
 * Survives Vite HMR. Abandoned Start / hot-reload left setInterval re-announce
 * loops publishing dead throwaway keys → other wallets saw 6–7 "live" with 4
 * real windows. Bumping the epoch makes every old loop no-op and self-clear.
 */
const JOIN_POOL_EPOCH_KEY = '__optn_p2p_join_pool_epoch__';

function joinPoolEpoch(): number {
  const g = globalThis as unknown as Record<string, number>;
  return g[JOIN_POOL_EPOCH_KEY] ?? 0;
}

/** Invalidate every joinPool re-announce loop in this JS realm (this window). */
export function invalidateJoinPoolAnnouncers(): number {
  const g = globalThis as unknown as Record<string, number>;
  const next = joinPoolEpoch() + 1;
  g[JOIN_POOL_EPOCH_KEY] = next;
  return next;
}

/**
 * Same-origin windows share pool announces without waiting on Tor.
 * Remote peers still meet only via Nostr (channel never leaves this origin).
 */
const POOL_BC_NAME = 'optn-p2p-pool-v1';

/** Subscribe to exactly one fresh network epoch and periodically re-announce. */
export function joinPool(
  pool: SimplePool,
  relays: string[],
  options: JoinPoolOptions
): {
  stop: () => void;
  announceNow: () => Promise<void>;
  withdraw: () => Promise<void>;
} {
  // Capture epoch after any prior invalidate so only THIS pool may announce.
  const myEpoch = joinPoolEpoch();
  const peers = new Map<string, PoolAnnouncement>();
  let stopped = false;
  let announceTimer: ReturnType<typeof setTimeout> | null = null;
  let repeatTimer: ReturnType<typeof setInterval> | null = null;
  const stillMine = () => !stopped && joinPoolEpoch() === myEpoch;
  const teardownTimers = () => {
    if (announceTimer) {
      clearTimeout(announceTimer);
      announceTimer = null;
    }
    if (repeatTimer) {
      clearInterval(repeatTimer);
      repeatTimer = null;
    }
  };
  // Look back far enough for Tor-lagged multi-wallet starts; collectRolling
  // still drops ghosts via live filter + retired keys.
  const subscribeSince =
    Math.floor(Date.now() / 1000) - POOL_SUBSCRIBE_LOOKBACK_SECONDS;
  const filter = {
    kinds: [POOL_ANNOUNCE_KIND],
    '#t': [poolTag(options.network)],
    since: subscribeSince,
  };
  const emitPeers = () => {
    if (!stillMine()) return;
    const now = Math.floor(Date.now() / 1000);
    // Drop expired / retired / unheard ghosts so callers that REPLACE their list
    // from this emit never re-accumulate abandoned Start keys.
    for (const [pubkey, ann] of peers) {
      const lastHeard = ann.seenAt ?? ann.at;
      if (
        ann.expiresAt < now ||
        isRetiredRoundKey(pubkey) ||
        lastHeard < now - POOL_LIVE_ACTIVE_SECONDS
      ) {
        peers.delete(pubkey);
      }
    }
    options.onPeer([...peers.values()]);
  };

  const admitAnnouncement = (ann: PoolAnnouncement) => {
    if (!stillMine()) return;
    if (isRetiredRoundKey(ann.pubkey)) return;
    const nowSec = Math.floor(Date.now() / 1000);
    const prev = peers.get(ann.pubkey);
    peers.set(ann.pubkey, {
      ...ann,
      at: prev ? Math.max(prev.at, ann.at) : ann.at,
      seenAt: nowSec,
    });
    emitPeers();
  };

  const sub = pool.subscribeMany(relays, filter, {
    onevent(evt: Event) {
      if (!stillMine()) return;
      if (isRetiredRoundKey(evt.pubkey)) return;
      const ann = parsePoolAnnouncement(evt, {
        network: options.network,
        epoch: options.epoch,
      });
      if (ann) {
        admitAnnouncement(ann);
        return;
      }
      // Withdraw publishes expiresAt = now-1; parse rejects it. Without this
      // branch the OLD live announcement stays in the Map until TTL — other
      // wallets still count that throwaway key as a peer.
      if (
        evt.kind === POOL_ANNOUNCE_KIND &&
        peers.has(evt.pubkey) &&
        hasTag(evt, 't', poolTag(options.network))
      ) {
        try {
          const content = JSON.parse(evt.content) as { expiresAt?: unknown };
          const expiresAt = Number(content.expiresAt);
          if (
            Number.isSafeInteger(expiresAt) &&
            expiresAt < Math.floor(Date.now() / 1000)
          ) {
            peers.delete(evt.pubkey);
            emitPeers();
          }
        } catch {
          /* ignore unparseable */
        }
      }
    },
  });

  // Same-origin peer bridge (multi-wallet on one machine). Remote users meet
  // on Nostr only — BroadcastChannel does not leave this app origin.
  let poolBc: BroadcastChannel | null = null;
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      poolBc = new BroadcastChannel(POOL_BC_NAME);
      poolBc.onmessage = (ev: MessageEvent) => {
        if (!stillMine()) return;
        const data = ev.data as {
          network?: string;
          ann?: PoolAnnouncement;
          withdraw?: string;
        } | null;
        if (!data || data.network !== options.network) return;
        if (typeof data.withdraw === 'string' && data.withdraw.length >= 32) {
          peers.delete(data.withdraw);
          emitPeers();
          return;
        }
        const ann = data.ann;
        if (
          !ann ||
          typeof ann.pubkey !== 'string' ||
          ann.pubkey === options.round.pubkey ||
          !Array.isArray(ann.tiers) ||
          typeof ann.at !== 'number' ||
          typeof ann.expiresAt !== 'number'
        ) {
          return;
        }
        admitAnnouncement(ann);
      };
    }
  } catch {
    poolBc = null;
  }

  const announce = async () => {
    if (!stillMine()) {
      teardownTimers();
      return;
    }
    // No `epoch` — it is stamped from the clock at build time. `options.epoch`
    // is captured once when the pool is joined, and a session outlives many
    // 30s buckets, so forwarding it would republish a bucket that is stale by
    // the time a verifier reads it.
    const evt = buildPoolAnnouncement(options.round, {
      network: options.network,
      tiers: options.tiers,
      numInputs: options.numInputs,
    });
    // ≥2 relay ACKs so multi-wallet gather shares topology (not first-OK alone).
    await publishEventAtLeastOnce(
      pool,
      relays,
      evt,
      options.signal,
      PUBLISH_POOL_MIN_ACKS
    );
    // Admit locally + same-origin bridge: do not wait for Tor to echo us, and
    // let other app windows discover us even when relays lag.
    const ann = parsePoolAnnouncement(evt, {
      network: options.network,
      epoch: options.epoch,
    });
    if (ann) {
      admitAnnouncement(ann);
      try {
        poolBc?.postMessage({ network: options.network, ann });
      } catch {
        /* ignore */
      }
    }
  };

  // Head-start Tor WSS before first shout (0–800ms was often too early).
  const firstAnnounceDelay =
    1_200 + Math.floor(Math.random() * MAX_ANNOUNCE_DELAY_MS);
  announceTimer = setTimeout(() => {
    void announce().catch((error: unknown) =>
      options.onError?.(
        error instanceof Error ? error : new Error(String(error))
      )
    );
  }, firstAnnounceDelay);
  repeatTimer = setInterval(() => {
    if (!stillMine()) {
      teardownTimers();
      return;
    }
    // Prune stale/retired keys even when no new events arrive (ghosts age out).
    emitPeers();
    void announce().catch((error: unknown) =>
      options.onError?.(
        error instanceof Error ? error : new Error(String(error))
      )
    );
  }, REANNOUNCE_MS);

  return {
    stop: () => {
      stopped = true;
      teardownTimers();
      try {
        poolBc?.close();
      } catch {
        /* ignore */
      }
      poolBc = null;
      sub.close();
    },
    announceNow: announce,
    /** Retire this round key from the pool so it never lingers as a ghost. */
    withdraw: async () => {
      stopped = true;
      teardownTimers();
      try {
        poolBc?.postMessage({
          network: options.network,
          withdraw: options.round.pubkey,
        });
        poolBc?.close();
      } catch {
        /* ignore */
      }
      poolBc = null;
      // Shared ghost list first so every window's next filter pass drops us
      // even if the expired replaceable is slow over Tor.
      retireRoundKey(options.round.pubkey);
      const evt = buildPoolAnnouncement(options.round, {
        network: options.network,
        tiers: options.tiers,
        numInputs: options.numInputs,
        withdraw: true,
      });
      // Cleanup must outlive the round signal. Wallet/network/mode changes abort
      // that signal before `finally` runs; reusing it here would reject before
      // `pool.publish` and leave this replaceable announcement discoverable as a
      // ghost until its TTL expires.
      await publishEventAtLeastOnce(pool, relays, evt).catch(() => undefined);
      sub.close();
    },
  };
}

/**
 * Deterministic coordinator, bound to the candidate set.
 *
 * The old rule was "lowest ephemeral pubkey wins", which is free to grind: a
 * key is a random 32 bytes, so an attacker generates them offline until it
 * holds one starting in zeros and then wins essentially every election it
 * enters, forever, at no cost per round.
 *
 * Now the winner is the lowest H(all candidate pubkeys, sorted || candidate),
 * so a key's rank depends on WHO ELSE is in the round. A precomputed key has no
 * standing advantage, and grinding has to happen after the set is known — that
 * is, inside the round's gather window, against a target that changes when any
 * other participant joins or leaves.
 *
 * Be precise about what this does and does not buy:
 *   - It removes the free, permanent advantage of an offline-ground key.
 *   - It does NOT stop an attacker who controls many identities from winning
 *     more often. That is Sybil resistance, a different property, and nothing
 *     here provides it. An attacker with N of M identities still coordinates
 *     roughly N/M of rounds, which is the honest baseline.
 */
export function electCoordinator(pubkeys: string[]): string | null {
  const candidates = [...new Set(pubkeys)].filter((key) => key.length > 0);
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  // Sorted, so every participant derives the identical commitment from the same
  // set regardless of the order their relays delivered the announcements in.
  const commitment = [...candidates].sort().join('|');

  let winner = candidates[0];
  let best = electionTicket(commitment, winner);
  for (const candidate of candidates.slice(1)) {
    const ticket = electionTicket(commitment, candidate);
    // Tie-break on the pubkey itself so the result is total and identical
    // everywhere; a tie needs a full hash collision, so this is a formality.
    if (ticket < best || (ticket === best && candidate < winner)) {
      best = ticket;
      winner = candidate;
    }
  }
  return winner;
}

/** FNV-1a over the set commitment and one candidate, as a fixed-width hex. */
function electionTicket(commitment: string, candidate: string): string {
  // A non-cryptographic hash is adequate here and deliberately chosen over
  // pulling in async WebCrypto: election must stay a synchronous pure function
  // that every peer can recompute identically. Its job is to scramble rank
  // relative to the set, not to resist preimage attacks — an attacker who can
  // invert this still has to do the work inside the round window, which is the
  // property being bought.
  const input = `${commitment}#${candidate}`;
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i += 1) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (c + i), 0x85ebca6b) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

export function isCoordinator(
  round: RoundIdentity,
  peerPubkeys: string[]
): boolean {
  return electCoordinator([round.pubkey, ...peerPubkeys]) === round.pubkey;
}
