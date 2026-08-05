import { describe, expect, it } from 'vitest';
import {
  generateRoundIdentity,
  buildPoolAnnouncement,
  electCoordinator,
  isCoordinator,
  isLivePoolAnnouncement,
  joinPool,
  poolTag,
  poolEpoch,
  parsePoolAnnouncement,
  selectFusionGroup,
  FUSION_POOL_PROTOCOL,
  POOL_ANNOUNCE_KIND,
  POOL_REANNOUNCE_SECONDS,
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

  // NOTE: these two once asserted "lowest pubkey wins". That rule was removed
  // because a 32-byte key is free to grind offline — pin it again and you pin
  // the vulnerability. What survives is the property the round actually needs:
  // every peer derives the SAME coordinator from the same set. The adversarial
  // properties of the replacement live in coordinatorElection.test.ts.
  it('coordinator election is deterministic and order-independent', () => {
    const keys = ['ff00', 'aa11', '0099', 'bb22'];
    expect(electCoordinator([])).toBeNull();
    // The winner is one of the candidates, and never depends on arrival order.
    const shuffles = [keys, [...keys].reverse(), [keys[2], keys[0], keys[3], keys[1]]];
    const winners = new Set(shuffles.map((s) => electCoordinator(s)));
    expect(winners.size).toBe(1);
    expect(keys).toContain(electCoordinator(keys));
  });

  it('isCoordinator includes our own key in the set', () => {
    const me = generateRoundIdentity();
    const peers = ['a'.repeat(64), 'f'.repeat(64)];
    // The point of the test: our own key must be a candidate, so the answer
    // matches the election run over the full set rather than over peers alone.
    expect(isCoordinator(me, peers)).toBe(
      electCoordinator([me.pubkey, ...peers]) === me.pubkey
    );
    expect(isCoordinator(me, [])).toBe(true);
  });

  it('pool announcement is a fresh, network-scoped kind-12230 event', () => {
    const round = generateRoundIdentity();
    const now = 1_800_000_005;
    const epoch = poolEpoch(now);
    const evt = buildPoolAnnouncement(round, {
      network: 'chipnet',
      epoch,
      tiers: [10_000, 100_000],
      numInputs: 3,
      nowSeconds: now,
    });
    expect(evt.kind).toBe(POOL_ANNOUNCE_KIND);
    expect(evt.pubkey).toBe(round.pubkey); // signed by the throwaway key, not the wallet
    expect(evt.tags).toContainEqual(['t', poolTag('chipnet')]);
    expect(evt.tags).toContainEqual(['n', 'chipnet']);
    // NIP-40 so relays can drop us after TTL (content expiresAt alone is not enough).
    expect(evt.tags).toContainEqual([
      'expiration',
      String(now + 180),
    ]);
    expect(verifyEvent(evt)).toBe(true);
    const c = JSON.parse(evt.content);
    expect(c).toMatchObject({
      protocol: FUSION_POOL_PROTOCOL,
      network: 'chipnet',
      epoch,
      tiers: [10_000, 100_000],
      numInputs: 3,
    });
    expect(
      parsePoolAnnouncement(evt, {
        network: 'chipnet',
        epoch,
        nowSeconds: now,
      })
    ).toMatchObject({ pubkey: round.pubkey, tiers: [10_000, 100_000] });
  });

  it('rejects stale, future, wrong-network, and tampered pool events', () => {
    const round = generateRoundIdentity();
    const now = 1_800_000_005;
    const epoch = poolEpoch(now);
    const evt = buildPoolAnnouncement(round, {
      network: 'chipnet',
      epoch,
      tiers: [10_000],
      numInputs: 1,
      nowSeconds: now,
    });
    const scope = { network: 'chipnet' as const, epoch, nowSeconds: now };

    expect(
      parsePoolAnnouncement(evt, { ...scope, nowSeconds: now + 200 })
    ).toBeNull();
    expect(
      parsePoolAnnouncement(evt, { ...scope, nowSeconds: now - 120 })
    ).toBeNull();
    expect(
      parsePoolAnnouncement(evt, { ...scope, network: 'mainnet' })
    ).toBeNull();
    expect(
      parsePoolAnnouncement({ ...evt, content: `${evt.content} ` }, scope)
    ).toBeNull();
  });

  it('selects the largest compatible fresh peer group, then the highest tier', () => {
    const peers = [
      { pubkey: '01', tiers: [10_000, 100_000], numInputs: 1 },
      { pubkey: '02', tiers: [10_000, 100_000], numInputs: 2 },
      { pubkey: '03', tiers: [10_000], numInputs: 1 },
    ];

    expect(selectFusionGroup(peers, 2, 10)).toEqual({
      tier: 10_000,
      participants: ['01', '02', '03'],
    });
  });

  it('never forms a group whose worst-case inputs and outputs exceed 100 components', () => {
    const peers = [
      { pubkey: '01', tiers: [100_000], numInputs: 40 },
      { pubkey: '02', tiers: [100_000], numInputs: 40 },
      { pubkey: '03', tiers: [100_000], numInputs: 40 },
    ];

    expect(selectFusionGroup(peers, 2, 10)).toEqual({
      tier: 100_000,
      participants: ['01', '02'],
    });
  });

  it('keeps Tor-lagged live peers and drops abandoned Start ghosts', () => {
    const self = 'aa'.repeat(32);
    const live = 'bb'.repeat(32);
    const ghost = 'cc'.repeat(32);
    const gatherStart = 1_800_000_000;
    // After 3 re-announce periods: demand fresh created_at.
    const now = gatherStart + POOL_REANNOUNCE_SECONDS * 3;
    const base = {
      nowSeconds: now,
      gatherStartSeconds: gatherStart,
      selfPubkey: self,
      isGhostKey: () => false,
    };

    expect(
      isLivePoolAnnouncement(
        { pubkey: self, at: gatherStart - 30, expiresAt: now + 60 },
        base
      )
    ).toBe(true);
    // Live peer: re-announce refreshed created_at recently.
    expect(
      isLivePoolAnnouncement(
        {
          pubkey: live,
          at: now - 5,
          seenAt: now - 2,
          expiresAt: now + 60,
        },
        base
      )
    ).toBe(true);
    // Tor delivered one re-announce a few seconds ago; created_at still fresh.
    expect(
      isLivePoolAnnouncement(
        {
          pubkey: live,
          at: now - 8,
          seenAt: now - 8,
          expiresAt: now + 60,
        },
        base
      )
    ).toBe(true);
    // Abandoned Start: old created_at, only heard at subscribe flood.
    expect(
      isLivePoolAnnouncement(
        {
          pubkey: ghost,
          at: gatherStart - 40,
          seenAt: gatherStart,
          expiresAt: now + 160,
        },
        base
      )
    ).toBe(false);
    // Early gather: recently heard peer counts even if created_at is a bit old.
    expect(
      isLivePoolAnnouncement(
        {
          pubkey: live,
          at: gatherStart - 10,
          seenAt: gatherStart + 1,
          expiresAt: gatherStart + 60,
        },
        { ...base, nowSeconds: gatherStart + 5 }
      )
    ).toBe(true);
    // Explicit ghost list (own / retired).
    expect(
      isLivePoolAnnouncement(
        { pubkey: live, at: now - 1, seenAt: now, expiresAt: now + 60 },
        { ...base, isGhostKey: (pk) => pk === live }
      )
    ).toBe(false);
  });

  it('publishes an expired withdrawal even after the round signal is aborted', async () => {
    const published: Array<{ content: string }> = [];
    const pool = {
      subscribeMany: () => ({ close: () => undefined }),
      publish: (_relays: string[], event: { content: string }) => {
        published.push(event);
        return [Promise.resolve('accepted')];
      },
    };
    const controller = new AbortController();
    const round = generateRoundIdentity();
    const joined = joinPool(
      pool as never,
      ['wss://relay.example'],
      {
        round,
        network: 'chipnet',
        epoch: 1,
        tiers: [10_000],
        numInputs: 1,
        signal: controller.signal,
        onPeer: () => undefined,
      }
    );

    controller.abort();
    await joined.withdraw();

    expect(published).toHaveLength(1);
    expect(JSON.parse(published[0].content).expiresAt).toBeLessThan(
      Math.floor(Date.now() / 1_000)
    );
  });
});
