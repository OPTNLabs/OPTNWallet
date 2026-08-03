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

describe('P2P Fusion coordinator-agreed round start', () => {
  it('converges on the coordinator participant set despite a partial relay view', async () => {
    const all = [peer(1), peer(2), peer(3)].sort();
    // The elected coordinator holds the full view; one of the others is missing
    // a peer entirely, which is what a partial relay view looks like.
    const lead = coordinatorOf(all);
    const [partial, full] = all.filter((pubkey) => pubkey !== lead);
    const hub = new Hub();
    const common = {
      network: 'chipnet' as const,
      tier: 10_000,
      epoch: 123,
      timeoutMs: 1_000,
      coordinatorSettleMs: 10,
    };

    const [rLead, rPartial, rFull] = await Promise.all([
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
        { ...common, myPubkey: partial, candidates: [lead, partial] },
        hub.transportFor(partial)
      ),
      negotiateFusionRound(
        { ...common, myPubkey: full, candidates: all },
        hub.transportFor(full)
      ),
    ]);

    // The peer that could only see two of us still ends up in the round of three.
    expect(
      new Set([rLead.session, rPartial.session, rFull.session])
    ).toEqual(new Set(['f'.repeat(64)]));
    expect(rLead.participants).toEqual(all);
    expect(rPartial.participants).toEqual(all);
    expect(rFull.participants).toEqual(all);
    expect(rLead.coordinator).toBe(lead);
    expect(rPartial.coordinator).toBe(lead);
  });

  it('yields to a better coordinator that was absent from the local relay view', async () => {
    const all = [peer(1), peer(2), peer(3)].sort();
    // The two peers that can see each other but NOT the eventual coordinator
    // start their own round; the coordinator's proposal lands late and wins.
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
          candidates: [x, y],
          sessionFactory: () => 'b'.repeat(64),
        },
        hub.transportFor(x)
      ),
      negotiateFusionRound(
        { ...common, myPubkey: y, candidates: [x, y] },
        hub.transportFor(y)
      ),
    ]);

    // Both abandon the round they had already started for the better one.
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
      // The ghost must be the peer the election actually picks, or no failover
      // happens and this test passes without exercising anything. It stands for
      // an abandoned round's stored announcement: still elected, never present.
      const all = [peer(1), peer(2), peer(3)].sort();
      const ghost = coordinatorOf(all);
      const live = all.filter((pubkey) => pubkey !== ghost);
      const survivor = coordinatorOf(live); // who takes over once the ghost is dropped
      const other = live.find((pubkey) => pubkey !== survivor) as string;
      const hub = new Hub();
      const common = {
        network: 'chipnet' as const,
        tier: 100_000,
        epoch: 789,
        timeoutMs: 6_000,
        coordinatorSettleMs: 50,
      };

      const [rSurvivor, rOther] = await Promise.all([
        negotiateFusionRound(
          {
            ...common,
            myPubkey: survivor,
            candidates: all,
            sessionFactory: () => 'b'.repeat(64),
          },
          hub.transportFor(survivor)
        ),
        negotiateFusionRound(
          { ...common, myPubkey: other, candidates: all },
          hub.transportFor(other)
        ),
      ]);

      expect([rSurvivor.coordinator, rOther.coordinator]).toEqual([
        survivor,
        survivor,
      ]);
      expect(rSurvivor.participants).toEqual(live);
      expect(rOther.participants).toEqual(live);
    },
    20_000
  );

  it('aborts instead of entering registration when a proposed peer never acknowledges', async () => {
    // We must be the one coordinating, or we sit waiting for a proposal and the
    // failure under test (nobody ACKs our own proposal) never happens.
    const pair = [peer(1), peer(2)].sort();
    const lead = coordinatorOf(pair);
    const hub = new Hub();

    await expect(
      negotiateFusionRound(
        {
          myPubkey: lead,
          candidates: pair,
          network: 'chipnet',
          tier: 10_000,
          epoch: 123,
          timeoutMs: 30,
          sessionFactory: () => 'e'.repeat(64),
        },
        hub.transportFor(lead)
      )
    ).rejects.toThrow('round acknowledgments timed out');

    expect(
      hub.sent.some(({ message }) => message.type === 'abort')
    ).toBe(true);
  });
});
