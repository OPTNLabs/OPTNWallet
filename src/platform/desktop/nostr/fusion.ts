// P2P CashFusion over Nostr — Phase 4, coordination foundation.
//
// Unlike server CashFusion (a central server does blind-signing + assembly),
// P2P fusion has no server: peers find each other on Nostr, elect a coordinator
// deterministically, and run the round over gift-wrapped messages. Privacy comes
// from Tor + one-time ephemeral keys (the user's "tor is enough" decision), NOT
// from blind signatures or a Pedersen amount-hiding scheme.
//
// This module is the transport/coordination layer:
//   - a throwaway ephemeral identity per round (never the wallet's nostr key, so
//     a pool announcement can't be linked to the user),
//   - a public pool announcement (kind 22230) after a random anti-fingerprint
//     delay, carrying only counts (how many inputs/outputs the peer brings),
//   - pool discovery by subscription,
//   - deterministic coordinator election (lowest ephemeral pubkey — no vote).
// The round protocol itself (input/output registration, tx assembly, verify +
// sign, broadcast) builds on top of this and is added next.

import { SimplePool, finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools';

/** Kind for the public pool-ready announcement (00-Wallet convention). */
export const POOL_ANNOUNCE_KIND = 22230;
/** 00-Wallet's NOSTR_KIND_JOINER, reserved. Round messages themselves ride
 *  standard NIP-59 gift-wrap (kind 1059) — see fusionTransport.ts — so they're
 *  indistinguishable on the wire from chat DMs rather than a fingerprintable kind. */
export const ROUND_MESSAGE_KIND = 22231;

/** Max random delay before announcing, so join timing can't fingerprint a peer. */
export const MAX_ANNOUNCE_DELAY_MS = 180_000;

/** The pool tag for a tier, so peers only discover others fusing the same size. */
export function poolTag(tier: number): string {
  return `optn-fusion-${tier}`;
}

/** A one-time identity for a single fusion round. Discarded when the round ends. */
export interface RoundIdentity {
  secretKey: Uint8Array;
  pubkey: string; // hex
}

export function generateRoundIdentity(): RoundIdentity {
  const secretKey = generateSecretKey();
  return { secretKey, pubkey: getPublicKey(secretKey) };
}

/** What a peer advertises when it's ready to fuse (no amounts, just counts). */
export interface PoolAnnouncement {
  pubkey: string; // ephemeral round pubkey
  tier: number;
  numInputs: number;
  numOutputs: number;
  at: number; // unix seconds
}

/**
 * Publish this peer's readiness (kind 22230) for `tier`. Public and unsigned by
 * the wallet's identity — it's signed by the throwaway round key. Returns the
 * published event so the caller can track its own announcement.
 */
export function buildPoolAnnouncement(
  round: RoundIdentity,
  tier: number,
  numInputs: number,
  numOutputs: number
): Event {
  return finalizeEvent(
    {
      kind: POOL_ANNOUNCE_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['t', poolTag(tier)]],
      content: JSON.stringify({ tier, numInputs, numOutputs }),
    },
    round.secretKey
  );
}

function parseAnnouncement(evt: Event): PoolAnnouncement | null {
  try {
    const c = JSON.parse(evt.content) as { tier: number; numInputs: number; numOutputs: number };
    if (typeof c.tier !== 'number') return null;
    return {
      pubkey: evt.pubkey,
      tier: c.tier,
      numInputs: c.numInputs ?? 0,
      numOutputs: c.numOutputs ?? 0,
      at: evt.created_at,
    };
  } catch {
    return null;
  }
}

/**
 * Announce readiness for `tier` after a random delay, and discover other peers
 * in the same pool. Calls `onPeer` for each announcement seen (including, later,
 * our own echoed back). Returns an object to stop and read the current peer set.
 */
export function joinPool(
  pool: SimplePool,
  relays: string[],
  round: RoundIdentity,
  tier: number,
  numInputs: number,
  numOutputs: number,
  onPeer: (peers: PoolAnnouncement[]) => void
): { stop: () => void; announceNow: () => void } {
  const peers = new Map<string, PoolAnnouncement>();
  let sub: { close: () => void } | null = null;
  let announceTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  sub = pool.subscribeMany(relays, { kinds: [POOL_ANNOUNCE_KIND], '#t': [poolTag(tier)] }, {
    onevent(evt: Event) {
      const ann = parseAnnouncement(evt);
      if (ann && ann.tier === tier) {
        peers.set(ann.pubkey, ann);
        onPeer([...peers.values()]);
      }
    },
  });

  const announce = () => {
    if (stopped) return;
    const evt = buildPoolAnnouncement(round, tier, numInputs, numOutputs);
    void Promise.allSettled(pool.publish(relays, evt));
  };
  // Random anti-fingerprint delay before the first announce.
  announceTimer = setTimeout(announce, Math.floor(Math.random() * MAX_ANNOUNCE_DELAY_MS));

  return {
    stop: () => {
      stopped = true;
      if (announceTimer) clearTimeout(announceTimer);
      sub?.close();
    },
    announceNow: announce,
  };
}

/**
 * Deterministic coordinator: the lowest ephemeral pubkey (lexicographic). Every
 * peer that sees the same set computes the same coordinator with no vote, so
 * there's no leader-election round-trip and no trusted party choosing it.
 */
export function electCoordinator(pubkeys: string[]): string | null {
  if (pubkeys.length === 0) return null;
  return [...pubkeys].sort()[0];
}

export function isCoordinator(round: RoundIdentity, peerPubkeys: string[]): boolean {
  const all = Array.from(new Set([round.pubkey, ...peerPubkeys]));
  return electCoordinator(all) === round.pubkey;
}
