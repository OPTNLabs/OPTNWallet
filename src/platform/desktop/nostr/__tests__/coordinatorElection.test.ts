// Coordinator election, and specifically what an attacker can buy.
//
// The old rule was "lowest ephemeral pubkey wins". A key is 32 random bytes, so
// that is free to grind offline: generate keys until one starts with zeros and
// win essentially every round thereafter, forever, at no per-round cost. These
// tests pin the property that replaces it — and are equally explicit about the
// property it does NOT provide.

import { describe, expect, it } from 'vitest';
import { electCoordinator, isCoordinator } from '../fusion';

const key = (seed: string) => seed.padEnd(64, '0');

describe('coordinator election', () => {
  it('agrees regardless of the order peers were discovered in', () => {
    // Relays deliver announcements in arbitrary order. Two peers deriving
    // different coordinators would split the round in half.
    const peers = [key('aa'), key('bb'), key('cc'), key('dd')];
    const shuffled = [peers[2], peers[0], peers[3], peers[1]];
    expect(electCoordinator(peers)).toBe(electCoordinator(shuffled));
  });

  it('is stable and total', () => {
    const peers = [key('11'), key('22'), key('33')];
    expect(electCoordinator(peers)).toBe(electCoordinator(peers));
    expect(peers).toContain(electCoordinator(peers));
  });

  it('returns null for no candidates and the only candidate for one', () => {
    expect(electCoordinator([])).toBeNull();
    expect(electCoordinator([key('ab')])).toBe(key('ab'));
  });

  it('ignores duplicates, which a replayed announcement produces', () => {
    const peers = [key('aa'), key('bb')];
    expect(electCoordinator([...peers, peers[0], peers[1]])).toBe(
      electCoordinator(peers)
    );
  });

  it('does NOT simply hand it to the numerically lowest key', () => {
    // The whole point. An all-zeros key is the cheapest possible grind target
    // under the old rule; here it has no special standing.
    const ground = '0'.repeat(64);
    const peers = [ground, key('ff'), key('ee'), key('dd')];
    const winner = electCoordinator(peers);
    expect(peers).toContain(winner);
    // Not asserting it never wins — with four candidates it wins sometimes by
    // chance, which is exactly the intended "no advantage" outcome. Asserting
    // it never wins would be asserting a bias in the other direction.
    expect(winner).not.toBeNull();
  });

  it('gives a precomputed low key no better than chance across many sets', () => {
    // The real property: rank depends on the SET, so a key ground offline
    // cannot carry an advantage from round to round.
    const ground = '0'.repeat(64);
    let wins = 0;
    const rounds = 400;
    for (let i = 0; i < rounds; i += 1) {
      // Four candidates: the ground key plus three fresh ones per round.
      const peers = [
        ground,
        key(`a${i}`),
        key(`b${i}`),
        key(`c${i}`),
      ];
      if (electCoordinator(peers) === ground) wins += 1;
    }
    // Fair share is 1/4. Under the OLD rule this was 400/400.
    expect(wins).toBeLessThan(rounds * 0.45);
    expect(wins).toBeGreaterThan(rounds * 0.05);
  });

  it('changes the winner when the candidate set changes', () => {
    // This is what forces grinding to happen inside the round window: the
    // target moves whenever anyone joins or leaves.
    const base = [key('aa'), key('bb'), key('cc')];
    const winners = new Set<string | null>();
    for (const extra of ['dd', 'ee', 'ff', '11', '22', '33', '44', '55']) {
      winners.add(electCoordinator([...base, key(extra)]));
    }
    expect(winners.size).toBeGreaterThan(1);
  });

  it('isCoordinator agrees with electCoordinator from the round key side', () => {
    const round = { pubkey: key('aa') } as Parameters<typeof isCoordinator>[0];
    const peers = [key('bb'), key('cc')];
    const expected = electCoordinator([round.pubkey, ...peers]);
    expect(isCoordinator(round, peers)).toBe(expected === round.pubkey);
  });

  it('does not claim Sybil resistance: many identities still win in proportion', () => {
    // Recorded so nobody later mistakes this for Sybil resistance. An attacker
    // holding half the identities coordinates about half the rounds, and no
    // election rule can change that without a scarce resource.
    let attackerWins = 0;
    const rounds = 300;
    for (let i = 0; i < rounds; i += 1) {
      const attacker = [key(`x${i}`), key(`y${i}`)];
      const honest = [key(`p${i}`), key(`q${i}`)];
      const winner = electCoordinator([...attacker, ...honest]);
      if (attacker.includes(winner as string)) attackerWins += 1;
    }
    // Around half, i.e. proportional to identity count — not suppressed.
    expect(attackerWins).toBeGreaterThan(rounds * 0.3);
    expect(attackerWins).toBeLessThan(rounds * 0.7);
  });
});
