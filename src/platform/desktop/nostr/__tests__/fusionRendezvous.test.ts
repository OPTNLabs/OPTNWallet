import { describe, expect, it } from 'vitest';

import type { RoundMessage, RoundTransport } from '../fusionSession';
import { negotiateFusionRound } from '../fusionRendezvous';

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
    const [a, b, c] = [peer(1), peer(2), peer(3)];
    const hub = new Hub();
    const common = {
      network: 'chipnet' as const,
      tier: 10_000,
      epoch: 123,
      timeoutMs: 1_000,
      coordinatorSettleMs: 10,
    };

    const [ra, rb, rc] = await Promise.all([
      negotiateFusionRound(
        {
          ...common,
          myPubkey: a,
          candidates: [a, b, c],
          sessionFactory: () => 'f'.repeat(64),
        },
        hub.transportFor(a)
      ),
      negotiateFusionRound(
        { ...common, myPubkey: b, candidates: [a, b] },
        hub.transportFor(b)
      ),
      negotiateFusionRound(
        { ...common, myPubkey: c, candidates: [a, b, c] },
        hub.transportFor(c)
      ),
    ]);

    expect(new Set([ra.session, rb.session, rc.session])).toEqual(
      new Set(['f'.repeat(64)])
    );
    expect(ra.participants).toEqual([a, b, c]);
    expect(rb.participants).toEqual([a, b, c]);
    expect(rc.participants).toEqual([a, b, c]);
    expect(ra.coordinator).toBe(a);
  });

  it('yields to a lower valid coordinator that was absent from the local relay view', async () => {
    const [a, b, c] = [peer(1), peer(2), peer(3)];
    const hub = new Hub((from, _to, message) =>
      from === a && message.type === 'round_proposal' ? 900 : 0
    );
    const common = {
      network: 'chipnet' as const,
      tier: 100_000,
      epoch: 456,
      timeoutMs: 2_000,
      coordinatorSettleMs: 1_200,
    };

    const [ra, rb, rc] = await Promise.all([
      negotiateFusionRound(
        {
          ...common,
          myPubkey: a,
          candidates: [a, b, c],
          sessionFactory: () => 'a'.repeat(64),
        },
        hub.transportFor(a)
      ),
      negotiateFusionRound(
        {
          ...common,
          myPubkey: b,
          candidates: [b, c],
          sessionFactory: () => 'b'.repeat(64),
        },
        hub.transportFor(b)
      ),
      negotiateFusionRound(
        { ...common, myPubkey: c, candidates: [b, c] },
        hub.transportFor(c)
      ),
    ]);

    expect([ra, rb, rc].map((round) => round.coordinator)).toEqual([a, a, a]);
    expect([ra, rb, rc].map((round) => round.session)).toEqual([
      'a'.repeat(64),
      'a'.repeat(64),
      'a'.repeat(64),
    ]);
    expect(rb.participants).toEqual([a, b, c]);
  });

  it('aborts instead of entering registration when a proposed peer never acknowledges', async () => {
    const [a, missing] = [peer(1), peer(2)];
    const hub = new Hub();

    await expect(
      negotiateFusionRound(
        {
          myPubkey: a,
          candidates: [a, missing],
          network: 'chipnet',
          tier: 10_000,
          epoch: 123,
          timeoutMs: 30,
          sessionFactory: () => 'e'.repeat(64),
        },
        hub.transportFor(a)
      )
    ).rejects.toThrow('round acknowledgments timed out');

    expect(
      hub.sent.some(({ message }) => message.type === 'abort')
    ).toBe(true);
  });
});
