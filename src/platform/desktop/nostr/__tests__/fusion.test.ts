import { describe, expect, it } from 'vitest';
import {
  generateRoundIdentity,
  buildPoolAnnouncement,
  electCoordinator,
  isCoordinator,
  poolTag,
  POOL_ANNOUNCE_KIND,
} from '../fusion';
import { verifyEvent } from 'nostr-tools';

describe('P2P fusion coordination', () => {
  it('round identity is a fresh throwaway key', () => {
    const a = generateRoundIdentity();
    const b = generateRoundIdentity();
    expect(a.pubkey).not.toBe(b.pubkey);
    expect(a.secretKey).toHaveLength(32);
    expect(a.pubkey).toMatch(/^[0-9a-f]{64}$/);
  });

  it('coordinator election is deterministic (lowest pubkey), order-independent', () => {
    const keys = ['ff00', 'aa11', '0099', 'bb22'];
    expect(electCoordinator(keys)).toBe('0099');
    expect(electCoordinator([...keys].reverse())).toBe('0099');
    expect(electCoordinator([])).toBeNull();
    // Every peer computing over the same set agrees on the coordinator.
    const shuffles = [keys, [...keys].reverse(), [keys[2], keys[0], keys[3], keys[1]]];
    const winners = new Set(shuffles.map((s) => electCoordinator(s)));
    expect(winners.size).toBe(1);
  });

  it('isCoordinator includes our own key in the set', () => {
    const me = generateRoundIdentity();
    // We win only if our pubkey is the lowest among all.
    const lower = 'a'.repeat(64) < me.pubkey ? ['a'.repeat(64)] : [];
    const higher = ['f'.repeat(64)];
    expect(isCoordinator(me, higher)).toBe(me.pubkey < 'f'.repeat(64));
    if (lower.length) expect(isCoordinator(me, lower)).toBe(false);
  });

  it('pool announcement is a valid kind-22230 event tagged for the tier', () => {
    const round = generateRoundIdentity();
    const evt = buildPoolAnnouncement(round, 10_000, 3, 2);
    expect(evt.kind).toBe(POOL_ANNOUNCE_KIND);
    expect(evt.pubkey).toBe(round.pubkey); // signed by the throwaway key, not the wallet
    expect(evt.tags).toContainEqual(['t', poolTag(10_000)]);
    expect(verifyEvent(evt)).toBe(true);
    const c = JSON.parse(evt.content);
    expect(c).toEqual({ tier: 10_000, numInputs: 3, numOutputs: 2 });
  });
});
