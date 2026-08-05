import { describe, expect, it } from 'vitest';

import type { RoundMessage, RoundTransport } from '../fusionSession';
import { negotiateFusionRound } from '../fusionRendezvous';
import { electCoordinator } from '../fusion';

/** Roles come from the real election, never from pubkey order. Restating the
 *  rule here is what made this whole file green-but-meaningless once: peers
 *  were handed roles the election did not agree with, so the negotiation under
 *  test never ran the path the test was named after. */
function coordinatorOf(peers: string[]): string {
  const elected = electCoordinator(peers);
  if (!elected) throw new Error('no coordinator elected for this set');
  return elected;
}

type Handler = (from: string, message: RoundMessage) => void;

class Hub {
  private handlers = new Map<string, Handler[]>();
  private mailbox = new Map<string, Array<[string, RoundMessage]>>();
  readonly sent: Array<{ from: string; to: string; message: RoundMessage }> = [];

  constructor(
    private readonly deliveryDelay = (
      from: string,
      to: string,
      message: RoundMessage
    ) => {
      void from;
      void to;
      void message;
      return 0;
    }
  ) {}

  transportFor(me: string): RoundTransport {
    return {
      send: async (to, message) => {
        this.sent.push({ from: me, to, message });
        const deliver = () => {
          const handlers = this.handlers.get(to);
          if (handlers?.length) {
            handlers.forEach((handler) => handler(me, message));
          } else {
            const queued = this.mailbox.get(to) ?? [];
            queued.push([me, message]);
            this.mailbox.set(to, queued);
          }
        };
        const delay = this.deliveryDelay(me, to, message);
        if (delay > 0) setTimeout(deliver, delay);
        else queueMicrotask(deliver);
      },
      onMessage: (handler) => {
        this.handlers.set(me, [...(this.handlers.get(me) ?? []), handler]);
        const queued = this.mailbox.get(me) ?? [];
        this.mailbox.set(me, []);
        queued.forEach(([from, message]) =>
          queueMicrotask(() => handler(from, message))
        );
        return () => {
          this.handlers.set(
            me,
            (this.handlers.get(me) ?? []).filter((item) => item !== handler)
          );
        };
      },
    };
  }
}

const peer = (n: number) => n.toString(16).padStart(64, '0');
const sameSorted = (a: string[], b: string[]) =>
  a.length === b.length &&
  [...a].sort().every((v, i) => v === [...b].sort()[i]);

describe('P2P Fusion coordinator-agreed round start', () => {
  it('still agrees when peers froze different pool epochs (gather spans epoch boundary)', async () => {
    // Rolling pool freezes epoch at Start; a 45s gather often crosses a 30s
    // bucket. Requiring epoch equality rejected every proposal → "Could not
    // agree on a round (4 in your view)".
    const all = [peer(1), peer(2), peer(3)].sort();
    const lead = coordinatorOf(all);
    const hub = new Hub();
    const results = await Promise.all(
      all.map((pubkey, index) =>
        negotiateFusionRound(
          {
            myPubkey: pubkey,
            candidates: all,
            network: 'chipnet',
            tier: 10_000,
            epoch: 100 + index, // deliberately different
            timeoutMs: 2_000,
            coordinatorSettleMs: 20,
            proposalTimeoutMs: 1_500,
            sessionFactory: () => 'a'.repeat(64),
          },
          hub.transportFor(pubkey)
        )
      )
    );
    expect(new Set(results.map((r) => r.session)).size).toBe(1);
    expect(results.every((r) => r.coordinator === lead)).toBe(true);
  });

  it('converges on the coordinator participant set despite a partial relay view', async () => {
    // MIN_PARTICIPANTS = 3: partial view must still include ≥3 keys (missing
    // one of four), not a 2-set which can no longer negotiate alone.
    const all = [peer(1), peer(2), peer(3), peer(4)].sort();
    const lead = coordinatorOf(all);
    const others = all.filter((pubkey) => pubkey !== lead);
    const partial = others[0];
    const fullA = others[1];
    const fullB = others[2];
    // Partial misses fullB entirely (asymmetric Tor view).
    const partialView = [lead, partial, fullA].sort();
    const hub = new Hub();
    const common = {
      network: 'chipnet' as const,
      tier: 10_000,
      epoch: 123,
      timeoutMs: 2_000,
      coordinatorSettleMs: 20,
    };

    const [rLead, rPartial, rFullA, rFullB] = await Promise.all([
      negotiateFusionRound(
        {
          ...common,
          myPubkey: lead,
          candidates: all,
          sessionFactory: () => 'f'.repeat(64),
        },
        hub.transportFor(lead)
      ),
      negotiateFusionRound(
        { ...common, myPubkey: partial, candidates: partialView },
        hub.transportFor(partial)
      ),
      negotiateFusionRound(
        { ...common, myPubkey: fullA, candidates: all },
        hub.transportFor(fullA)
      ),
      negotiateFusionRound(
        { ...common, myPubkey: fullB, candidates: all },
        hub.transportFor(fullB)
      ),
    ]);

    // Partial still lands in the coordinator's full-set round via outrank.
    expect(
      new Set(
        [rLead, rPartial, rFullA, rFullB].map((r) => r.session)
      )
    ).toEqual(new Set(['f'.repeat(64)]));
    expect(rLead.participants).toEqual(all);
    expect(rPartial.participants).toEqual(all);
    expect(rLead.coordinator).toBe(lead);
  });

  it('yields to a better coordinator that was absent from the local relay view', async () => {
    const all = [peer(1), peer(2), peer(3)].sort();
    // Late lead wins; x and y still know about all three (min set size).
    const lead = coordinatorOf(all);
    const [x, y] = all.filter((pubkey) => pubkey !== lead);
    const hub = new Hub((from, _to, message) =>
      from === lead && message.type === 'round_proposal' ? 900 : 0
    );
    const common = {
      network: 'chipnet' as const,
      tier: 100_000,
      epoch: 456,
      timeoutMs: 2_000,
      coordinatorSettleMs: 1_200,
    };

    const [rLead, rx, ry] = await Promise.all([
      negotiateFusionRound(
        {
          ...common,
          myPubkey: lead,
          candidates: all,
          sessionFactory: () => 'a'.repeat(64),
        },
        hub.transportFor(lead)
      ),
      negotiateFusionRound(
        {
          ...common,
          myPubkey: x,
          candidates: all,
          sessionFactory: () => 'b'.repeat(64),
        },
        hub.transportFor(x)
      ),
      negotiateFusionRound(
        { ...common, myPubkey: y, candidates: all },
        hub.transportFor(y)
      ),
    ]);

    expect([rLead, rx, ry].map((round) => round.coordinator)).toEqual([
      lead,
      lead,
      lead,
    ]);
    expect([rLead, rx, ry].map((round) => round.session)).toEqual([
      'a'.repeat(64),
      'a'.repeat(64),
      'a'.repeat(64),
    ]);
    expect(rx.participants).toEqual(all);
  });

  it(
    're-elects when the elected coordinator is a ghost that never proposes',
    async () => {
      // Ghost + 3 live so after drop we still have ≥3 for the anonymity floor.
      const all = [peer(1), peer(2), peer(3), peer(4)].sort();
      const ghost = coordinatorOf(all);
      const live = all.filter((pubkey) => pubkey !== ghost);
      const survivor = coordinatorOf(live);
      const others = live.filter((pubkey) => pubkey !== survivor);
      const hub = new Hub();
      const common = {
        network: 'chipnet' as const,
        tier: 100_000,
        epoch: 789,
        timeoutMs: 10_000,
        coordinatorSettleMs: 40,
        proposalTimeoutMs: 1_200,
      };

      const survivorRound = negotiateFusionRound(
        {
          ...common,
          myPubkey: survivor,
          candidates: all,
          sessionFactory: () => 'b'.repeat(64),
        },
        hub.transportFor(survivor)
      );
      await new Promise((resolve) => setTimeout(resolve, 700));
      const otherRounds = others.map((pubkey) =>
        negotiateFusionRound(
          { ...common, myPubkey: pubkey, candidates: all },
          hub.transportFor(pubkey)
        )
      );

      const results = await Promise.all([survivorRound, ...otherRounds]);
      expect(results.every((r) => r.coordinator === survivor)).toBe(true);
      expect(results.every((r) => sameSorted(r.participants, live))).toBe(true);
    },
    20_000
  );

  it('aborts instead of entering registration when a proposed peer never acknowledges', async () => {
    // Three candidates so we clear the anonymity floor; only the coord runs.
    const trio = [peer(1), peer(2), peer(3)].sort();
    const lead = coordinatorOf(trio);
    const hub = new Hub();

    await expect(
      negotiateFusionRound(
        {
          myPubkey: lead,
          candidates: trio,
          network: 'chipnet',
          tier: 10_000,
          epoch: 123,
          timeoutMs: 80,
          sessionFactory: () => 'e'.repeat(64),
        },
        hub.transportFor(lead)
      )
    ).rejects.toThrow('round acknowledgments timed out');

    expect(
      hub.sent.some(({ message }) => message.type === 'abort')
    ).toBe(true);
  });

  it('never starts a 2-of-4 subset — full proposed set or abort', async () => {
    // Product failure (live 2026-08-06): gather saw 4, ACK bar degraded to pair,
    // two fused, two left alone. Scalable policy: full set or abort.
    const all = [peer(1), peer(2), peer(3), peer(4)].sort();
    const lead = coordinatorOf(all);
    const acker = all.find((p) => p !== lead) as string;
    const hub = new Hub();

    const coordPromise = negotiateFusionRound(
      {
        myPubkey: lead,
        candidates: all,
        network: 'chipnet',
        tier: 100_000,
        epoch: 1,
        timeoutMs: 500,
        coordinatorSettleMs: 40,
        sessionFactory: () => 'f'.repeat(64),
      },
      hub.transportFor(lead)
    );

    // Only ONE of the three others participates — old policy would start a pair.
    const oneAck = negotiateFusionRound(
      {
        myPubkey: acker,
        candidates: all,
        network: 'chipnet',
        tier: 100_000,
        epoch: 1,
        timeoutMs: 500,
        proposalTimeoutMs: 400,
      },
      hub.transportFor(acker)
    );

    await expect(coordPromise).rejects.toThrow(/1\/4|2\/4|Refusing a partial|timed out/i);
    await oneAck.catch(() => undefined);

    const partialStart = hub.sent.some(
      ({ message }) =>
        message.type === 'round_start' &&
        Array.isArray((message as { participants?: string[] }).participants) &&
        (message as { participants: string[] }).participants.length < 4
    );
    expect(partialStart).toBe(false);
  });
});
