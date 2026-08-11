import { describe, expect, it, vi } from 'vitest';
import {
  SimplePool,
  generateSecretKey,
  getPublicKey,
  type Event,
} from 'nostr-tools';
import {
  secp256k1,
  createVirtualMachineBCH2023,
  decodeTransaction,
  encodeLockingBytecodeP2pkh,
  binToHex,
  hexToBin,
  sha256,
  type TransactionCommon,
} from '@bitauth/libauth';
import { hash160 } from '@cashscript/utils';
import {
  createNostrRoundTransport,
  GIFT_WRAP_KIND,
  ONE_SHOT_POOL_LINGER_MS,
} from '../fusionTransport';
import {
  parseRoundMessage,
  messageBinding,
  runFusionRound,
  type RoundParams,
} from '../fusionSession';
import { assembleFusionTx, type PeerContribution } from '../fusionRound';
import { toLibauthTx } from '../fusionSign';
import { PUBLISH_RELAY_TIMEOUT_MS } from '../fusion';

/** Minimal relay stand-in: stores events and delivers to subscriptions whose
 *  {kinds, #p} filter matches — including subscriptions opened later. */
class FakePool {
  private events: Event[] = [];
  private subs: Array<{
    filter: Record<string, unknown>;
    onevent: (e: Event) => void;
  }> = [];
  private matches(filter: Record<string, unknown>, e: Event): boolean {
    const kinds = filter.kinds as number[] | undefined;
    if (kinds && !kinds.includes(e.kind)) return false;
    const pTags = filter['#p'] as string[] | undefined;
    if (pTags && !e.tags.some((t) => t[0] === 'p' && pTags.includes(t[1])))
      return false;
    return true;
  }
  closed = false;
  get publishedCount(): number {
    return this.events.length;
  }
  close(): void {
    this.closed = true;
  }
  publish(_relays: string[], event: Event): Promise<string>[] {
    this.events.push(event);
    for (const s of this.subs)
      if (this.matches(s.filter, event)) queueMicrotask(() => s.onevent(event));
    return [Promise.resolve('ok')];
  }
  subscribeMany(
    _relays: string[],
    filter: Record<string, unknown>,
    cbs: { onevent: (e: Event) => void }
  ) {
    const sub = { filter, onevent: cbs.onevent };
    this.subs.push(sub);
    for (const e of this.events)
      if (this.matches(filter, e)) queueMicrotask(() => cbs.onevent(e));
    return {
      close: () => {
        this.subs = this.subs.filter((s) => s !== sub);
      },
    };
  }
}
const asPool = (p: FakePool) => p as unknown as SimplePool;

function kp(seed: number) {
  const priv = new Uint8Array(32);
  priv[31] = seed & 0xff;
  priv[30] = (seed >> 8) & 0xff;
  const pub = secp256k1.derivePublicKeyCompressed(priv);
  if (typeof pub === 'string') throw new Error(pub);
  return { priv, pubHex: binToHex(pub) };
}
const p2pkhHex = (h: string) =>
  binToHex(encodeLockingBytecodeP2pkh(hash160(hexToBin(h))));
function roundId() {
  const sk = generateSecretKey();
  return { secretKey: sk, pubkey: getPublicKey(sk) };
}

describe('Nostr round transport', () => {
  it('keeps a one-shot component socket alive beyond the relay ACK deadline', () => {
    expect(ONE_SHOT_POOL_LINGER_MS).toBeGreaterThan(PUBLISH_RELAY_TIMEOUT_MS);
  });

  it('rejects protocol-v2 messages without downgrade fallback', () => {
    expect(
      parseRoundMessage(
        JSON.stringify({
          ...messageBinding(),
          version: 2,
          type: 'abort',
          session: 'round',
          reason: 'old peer',
        })
      )
    ).toBeNull();
  });
  it('rejects malformed or oversized round-message components before dispatch', () => {
    expect(
      parseRoundMessage(
        JSON.stringify({ type: 'inputs', session: 'round', inputs: [{}] })
      )
    ).toBeNull();
    expect(
      parseRoundMessage(
        JSON.stringify({
          type: 'outputs',
          session: 'round',
          outputs: [{ script: '00'.repeat(10_001), value: 1 }],
        })
      )
    ).toBeNull();
    expect(
      parseRoundMessage(
        JSON.stringify({
          type: 'outputs',
          session: 'round',
          outputs: [{ script: '00', value: 545 }],
        })
      )
    ).toBeNull();
    expect(
      parseRoundMessage(
        JSON.stringify({
          ...messageBinding(),
          type: 'abort',
          session: 'round',
          reason: 'cancelled',
        })
      )
    ).toEqual(
      expect.objectContaining({
        type: 'abort',
        session: 'round',
        reason: 'cancelled',
      })
    );
  });

  it('fails send when every configured relay rejects the event', async () => {
    const rejecting = {
      publish: () => [Promise.reject(new Error('relay rejected'))],
      subscribeMany: () => ({ close: () => undefined }),
    } as unknown as SimplePool;
    const sender = roundId();
    const recipient = roundId();
    const transport = createNostrRoundTransport(
      rejecting,
      ['wss://rejecting'],
      sender
    );

    await expect(
      transport.send(recipient.pubkey, {
        ...messageBinding(),
        type: 'abort',
        session: 'round',
        reason: 'test',
      })
    ).rejects.toThrow(/No Nostr relay accepted/i);
  });

  it('does not hang forever when one relay accepts and another never acknowledges', async () => {
    vi.useFakeTimers();
    try {
      const partlySilent = {
        publish: () => [
          Promise.resolve('accepted'),
          new Promise<string>(() => undefined),
        ],
        subscribeMany: () => ({ close: () => undefined }),
      } as unknown as SimplePool;
      const sender = roundId();
      const recipient = roundId();
      const transport = createNostrRoundTransport(
        partlySilent,
        ['wss://accepted', 'wss://silent'],
        sender
      );

      let settled = false;
      void transport
        .send(recipient.pubkey, {
          ...messageBinding(),
          type: 'abort',
          session: 'round',
          reason: 'test',
        })
        .then(() => {
          settled = true;
        });

      await vi.advanceTimersByTimeAsync(30_000);
      await Promise.resolve();
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels a silent relay publish immediately when the wallet session ends', async () => {
    const silent = {
      publish: () => [new Promise<string>(() => undefined)],
      subscribeMany: () => ({ close: () => undefined }),
    } as unknown as SimplePool;
    const sender = roundId();
    const recipient = roundId();
    const controller = new AbortController();
    const transport = createNostrRoundTransport(
      silent,
      ['wss://silent'],
      sender,
      silent,
      controller.signal
    );

    const sending = transport.send(recipient.pubkey, {
      ...messageBinding(),
      type: 'abort',
      session: 'round',
      reason: 'test',
    });
    controller.abort();

    await expect(sending).rejects.toThrow(/fusion round cancelled/i);
  });

  it('publishes anonymous outputs through the isolated output pool', async () => {
    const controlPool = new FakePool();
    const outputPool = new FakePool();
    const sender = roundId();
    const recipient = roundId();
    const transport = createNostrRoundTransport(
      asPool(controlPool),
      ['wss://fake'],
      sender,
      asPool(outputPool)
    );

    await transport.send(recipient.pubkey, {
      ...messageBinding(),
      type: 'inputs',
      session: 'round',
      inputs: [
        {
          prevTxid: 'ab'.repeat(32),
          prevIndex: 0,
          value: 10_000,
          pubkey: `02${'11'.repeat(32)}`,
        },
      ],
      credentialSigs: ['aa'.repeat(64)],
    });
    await transport.send(recipient.pubkey, {
      ...messageBinding(),
      type: 'outputs',
      session: 'round',
      outputs: [
        {
          script: '00',
          value: 546,
          credentialSerial: '11'.repeat(32),
          credentialSig: '22'.repeat(64),
          saltCommitment: '33'.repeat(32),
        },
      ],
    });

    // Inputs are anonymous COMPONENTS too, so both the input and the output
    // leave over the isolated pool. Only control-plane traffic keeps the
    // round-identity pool — that split is the whole point.
    await transport.send(recipient.pubkey, {
      ...messageBinding(),
      type: 'components_ready',
      session: 'round',
    });
    expect(outputPool.publishedCount).toBe(2);
    expect(controlPool.publishedCount).toBe(1);
  });

  // A fresh throwaway signing key per output is defeated at the transport layer
  // if every output still leaves over one socket: the relay groups them by
  // connection and learns the set anyway. Each anonymous component must get its
  // own pool, and that pool must be closed so nothing later reuses the circuit.
  it('gives every anonymous component its own one-shot pool and closes it', async () => {
    const controlPool = new FakePool();
    const sharedOutputPool = new FakePool();
    const oneShot: FakePool[] = [];
    const sender = roundId();
    const recipient = roundId();
    const transport = createNostrRoundTransport(
      asPool(controlPool),
      ['wss://fake'],
      sender,
      asPool(sharedOutputPool),
      undefined,
      () => {
        const p = new FakePool();
        oneShot.push(p);
        return asPool(p);
      }
    );

    // Fake timers must be installed BEFORE the sends: the deferred close is
    // scheduled during send(), and a timer scheduled on the real clock cannot
    // be advanced afterwards.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const output = (script: string) => ({
      ...messageBinding(),
      type: 'outputs' as const,
      session: 'round',
      outputs: [
        {
          script,
          value: 546,
          credentialSerial: '11'.repeat(32),
          credentialSig: '22'.repeat(64),
          saltCommitment: '33'.repeat(32),
        },
      ],
    });
    await transport.send(recipient.pubkey, output('00'));
    await transport.send(recipient.pubkey, output('51'));
    // Control-plane traffic keeps the round identity and the shared pool.
    await transport.send(recipient.pubkey, {
      ...messageBinding(),
      type: 'components_ready',
      session: 'round',
    });

    expect(oneShot).toHaveLength(2);
    expect(oneShot.map((p) => p.publishedCount)).toEqual([1, 1]);
    // Close is deferred so relays past the first ACK still receive the event.
    expect(oneShot.some((p) => p.closed)).toBe(false);
    vi.advanceTimersByTime(ONE_SHOT_POOL_LINGER_MS + 1);
    expect(oneShot.every((p) => p.closed)).toBe(true);
    vi.useRealTimers();
    // Nothing anonymous fell back to the shared socket.
    expect(sharedOutputPool.publishedCount).toBe(0);
    expect(controlPool.publishedCount).toBe(1);
  });

  it('gift-wraps a message (kind 1059) to the peer and round-trips', async () => {
    const relays = ['wss://fake'];
    const pool = new FakePool();
    const a = roundId();
    const b = roundId();
    const ta = createNostrRoundTransport(asPool(pool), relays, a);
    const tb = createNostrRoundTransport(asPool(pool), relays, b);

    const got: Array<{ from: string; type: string }> = [];
    tb.onMessage((from, msg) => got.push({ from, type: msg.type }));
    // A CONTROL message: the round identity is correct here and must survive
    // the round-trip. Components (inputs / outputs / signature) deliberately do
    // NOT — see the throwaway-key test below.
    await ta.send(b.pubkey, {
      ...messageBinding(),
      type: 'components_ready',
      session: 's',
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(got).toHaveLength(1);
    expect(got[0].from).toBe(a.pubkey);
    expect(got[0].type).toBe('components_ready');
    // Standard NIP-59 gift-wrap — indistinguishable on the wire from a chat DM,
    // not a custom fusion kind that would fingerprint the round.
    expect(GIFT_WRAP_KIND).toBe(1059);
  });

  it('signs OUTPUT messages with a throwaway key (unlinkable from the round identity)', async () => {
    const pool = new FakePool();
    const a = roundId();
    const b = roundId();
    const ta = createNostrRoundTransport(asPool(pool), ['wss://fake'], a);
    const tb = createNostrRoundTransport(asPool(pool), ['wss://fake'], b);

    let fromPubkey = '';
    tb.onMessage((from, msg) => {
      if (msg.type === 'outputs') fromPubkey = from;
    });
    await ta.send(b.pubkey, {
      ...messageBinding(),
      type: 'outputs',
      session: 's',
      outputs: [
        {
          script: '00',
          value: 546,
          credentialSerial: '11'.repeat(32),
          credentialSig: '22'.repeat(64),
          saltCommitment: '33'.repeat(32),
        },
      ],
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(fromPubkey).not.toBe('');
    expect(fromPubkey).not.toBe(a.pubkey); // NOT the round key → can't be linked to its inputs
  });

  it('drives a full 3-peer onion round to a VM-valid CoinJoin over the transport', async () => {
    const pool = new FakePool();
    const relays = ['wss://fake'];

    const peers = [1, 2, 3].map((n) => {
      const inKey = kp(n * 10 + 1);
      const outKey = kp(n * 10 + 2);
      const round = roundId();
      const contribution: PeerContribution = {
        inputs: [
          {
            prevTxid: `${n}${'c'.repeat(63)}`,
            prevIndex: n,
            value: 100_000,
            pubkey: inKey.pubHex,
          },
        ],
        outputs: [{ script: p2pkhHex(outKey.pubHex), value: 99_600 }],
      };
      return {
        round,
        keys: new Map([
          [inKey.pubHex, inKey.priv],
          [round.pubkey, round.secretKey], // round identity peels onion layers
        ]),
        contribution,
      };
    });
    const participants = peers.map((p) => p.round.pubkey);
    let broadcasts = 0;
    const broadcast = async (txHex: string) => {
      broadcasts += 1;
      return binToHex(sha256.hash(sha256.hash(hexToBin(txHex))).reverse());
    };

    const results = await Promise.all(
      peers.map((p) => {
        const params: RoundParams = {
          myPubkey: p.round.pubkey,
          participants,
          tier: 100_000,
          feerate: 1000,
          myContribution: p.contribution,
          keysByPubkey: p.keys,
          broadcast,
          timeoutMs: 8_000,
          jitterMs: [0, 0],
        };
        return runFusionRound(
          params,
          createNostrRoundTransport(asPool(pool), relays, p.round)
        );
      })
    );

    expect(new Set(results.map((r) => r.txid)).size).toBe(1);
    expect(broadcasts).toBe(1);

    const decoded = decodeTransaction(
      hexToBin(results[0].txHex)
    ) as TransactionCommon;
    const { sourceOutputs } = toLibauthTx(
      assembleFusionTx(peers.map((p) => p.contribution))
    );
    expect(
      createVirtualMachineBCH2023().verify({
        transaction: decoded,
        sourceOutputs,
      })
    ).toBe(true);
    expect(decoded.inputs).toHaveLength(3);
    expect(decoded.outputs).toHaveLength(3);
  });
});
