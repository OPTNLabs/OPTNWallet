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
export const MAX_ANNOUNCE_DELAY_MS = 3_000;
// The announcement is a stored replaceable event, so the relay keeps serving the
// latest one to new subscribers — frequent re-announcing buys nothing and made
// relays answer "rate-limited: you are noting too much". Refresh slowly, just
// often enough to stay inside the peer-active window.
const REANNOUNCE_MS = 12_000;
const MAX_FUTURE_SKEW_SECONDS = 5;
const MAX_ANNOUNCEMENT_BYTES = 2_048;
const MAX_TIERS = 16;
const MAX_INPUTS = 100;
const MAX_TOTAL_COMPONENTS = 100;
const MAX_OUTPUTS_PER_PEER = 4;

// ─── Gathering model: 6 peers OR timeout with 2+ ───────────────────────
/** Maximum participants per round (onion mix-net cap). */
export const MAX_PARTICIPANTS = 6;
/** Minimum participants to start a round (must have at least 2). */
export const MIN_PARTICIPANTS = 2;
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
 *  Must be longer than the rendezvous timeout (15 s default in
 *  fusionRendezvous.ts — Tor ack RTT) so peers still discover each other while
 *  negotiating, but short enough that stale announcements from finished rounds
 *  do not linger. 180 s was 9× the round window and caused "needs at least two
 *  fresh peers" failures. */
export const POOL_PEER_TTL_SECONDS = 30;

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
  at: number;
  expiresAt: number;
}

export interface BuildPoolAnnouncementOptions {
  network: FusionPoolNetwork;
  epoch: number;
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
  const content = JSON.stringify({
    protocol: FUSION_POOL_PROTOCOL,
    network: options.network,
    epoch: options.epoch, // informational only (rolling pool no longer filters on it)
    tiers,
    numInputs: options.numInputs,
    // A withdrawal replaces our stored announcement with an expired one, so every
    // peer's freshness check drops us at once instead of leaving a ghost that can
    // win coordinator election and stall the next round.
    expiresAt: options.withdraw ? now - 1 : now + POOL_PEER_TTL_SECONDS,
  });

  return finalizeEvent(
    {
      kind: POOL_ANNOUNCE_KIND,
      created_at: now,
      tags: [
        ['t', poolTag(options.network)],
        ['n', options.network],
        ['v', String(FUSION_POOL_PROTOCOL)],
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
    if (
      content.protocol !== FUSION_POOL_PROTOCOL ||
      content.network !== scope.network ||
      tiers.length === 0 ||
      tiers.length > MAX_TIERS ||
      !Number.isSafeInteger(numInputs) ||
      numInputs < 1 ||
      numInputs > MAX_INPUTS ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt < now
    ) {
      return null;
    }
    return {
      pubkey: evt.pubkey,
      network: scope.network,
      epoch: scope.epoch,
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

/** A relay that accepts the socket but never answers OK must not stall a round. */
const PUBLISH_TIMEOUT_MS = 30_000;

export async function publishEventAtLeastOnce(
  pool: SimplePool,
  relays: string[],
  event: Event,
  signal?: AbortSignal
): Promise<void> {
  if (relays.length === 0) throw new Error('No Nostr relays configured.');
  if (signal?.aborted) throw new Error('fusion round cancelled');
  // Bound every relay attempt. `pool.publish` resolves per relay only when that
  // relay answers OK, so a relay that opens the socket and then goes quiet leaves
  // its promise pending forever — and Promise.allSettled waits for ALL of them,
  // so one silent relay hangs the whole announce with no error and no way out.
  // A timed-out attempt counts as a failure, not a success: if EVERY relay times
  // out the announcement never landed and the round must fail loudly.
  const attempts = pool.publish(relays, event).map(
    (attempt) =>
      new Promise<void>((resolve, reject) => {
        let finished = false;
        const finish = (error?: unknown) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          if (error === undefined) resolve();
          else reject(error);
        };
        const onAbort = () => finish(new Error('fusion round cancelled'));
        const timer = setTimeout(
          () => finish(new Error('relay did not acknowledge in time')),
          PUBLISH_TIMEOUT_MS
        );
        signal?.addEventListener('abort', onAbort, { once: true });
        attempt.then(
          () => finish(),
          (error) => finish(error)
        );
        if (signal?.aborted) onAbort();
      })
  );
  const settled = await Promise.allSettled(attempts);
  if (signal?.aborted) throw new Error('fusion round cancelled');
  if (!settled.some((result) => result.status === 'fulfilled')) {
    const reason = settled.find((result) => result.status === 'rejected');
    throw new Error(
      `No Nostr relay accepted the Fusion message${
        reason && reason.status === 'rejected'
          ? `: ${String(reason.reason)}`
          : '.'
      }`
    );
  }
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
  const peers = new Map<string, PoolAnnouncement>();
  let stopped = false;
  let announceTimer: ReturnType<typeof setTimeout> | null = null;
  let repeatTimer: ReturnType<typeof setInterval> | null = null;
  const filter = {
    kinds: [POOL_ANNOUNCE_KIND],
    '#t': [poolTag(options.network)],
    since: Math.floor(Date.now() / 1000) - POOL_PEER_TTL_SECONDS,
  };
  const sub = pool.subscribeMany(relays, filter, {
    onevent(evt: Event) {
      const ann = parsePoolAnnouncement(evt, {
        network: options.network,
        epoch: options.epoch,
      });
      if (!ann) return;
      peers.set(ann.pubkey, ann);
      options.onPeer([...peers.values()]);
    },
  });

  const announce = async () => {
    if (stopped) return;
    const evt = buildPoolAnnouncement(options.round, {
      network: options.network,
      epoch: options.epoch,
      tiers: options.tiers,
      numInputs: options.numInputs,
    });
    await publishEventAtLeastOnce(pool, relays, evt, options.signal);
  };

  announceTimer = setTimeout(
    () => {
      void announce().catch((error: unknown) =>
        options.onError?.(
          error instanceof Error ? error : new Error(String(error))
        )
      );
    },
    Math.floor(Math.random() * MAX_ANNOUNCE_DELAY_MS)
  );
  repeatTimer = setInterval(() => {
    void announce().catch((error: unknown) =>
      options.onError?.(
        error instanceof Error ? error : new Error(String(error))
      )
    );
  }, REANNOUNCE_MS);

  return {
    stop: () => {
      stopped = true;
      if (announceTimer) clearTimeout(announceTimer);
      if (repeatTimer) clearInterval(repeatTimer);
      sub.close();
    },
    announceNow: announce,
    /** Retire this round key from the pool so it never lingers as a ghost. */
    withdraw: async () => {
      stopped = true;
      if (announceTimer) clearTimeout(announceTimer);
      if (repeatTimer) clearInterval(repeatTimer);
      const evt = buildPoolAnnouncement(options.round, {
        network: options.network,
        epoch: options.epoch,
        tiers: options.tiers,
        numInputs: options.numInputs,
        withdraw: true,
      });
      // Cleanup must outlive the round signal. Wallet/network/mode changes abort
      // that signal before `finally` runs; reusing it here would reject before
      // `pool.publish` and leave this replaceable announcement discoverable as a
      // ghost until its TTL expires.
      await publishEventAtLeastOnce(pool, relays, evt).catch(() => undefined);
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
