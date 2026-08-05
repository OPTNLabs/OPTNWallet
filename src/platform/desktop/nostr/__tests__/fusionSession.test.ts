import { describe, expect, it } from 'vitest';
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
import { runFusionRound, messageBinding, type RoundMessage, type RoundTransport, type RoundParams } from '../fusionSession';
import { assembleFusionTx, type PeerContribution } from '../fusionRound';
import { electCoordinator } from '../fusion';
import { toLibauthTx } from '../fusionSign';

/** Ask the real election who coordinates. Never restate the rule here: it is
 *  bound to the candidate set (fusion.ts), so a test that assumes "lowest
 *  pubkey wins" aims its fault injection at a peer that isn't coordinating and
 *  quietly proves nothing — which is exactly what happened when the election
 *  stopped being grindable. */
function coordinatorOf(participants: string[]): string {
  const elected = electCoordinator(participants);
  if (!elected) throw new Error('no coordinator elected for this round');
  return elected;
}

function keypair(seed: number): { priv: Uint8Array; pubHex: string } {
  const priv = new Uint8Array(32);
  priv[31] = seed & 0xff;
  priv[30] = (seed >> 8) & 0xff;
  const pub = secp256k1.derivePublicKeyCompressed(priv);
  if (typeof pub === 'string') throw new Error(pub);
  return { priv, pubHex: binToHex(pub) };
}
const p2pkhHex = (pubHex: string) => binToHex(encodeLockingBytecodeP2pkh(hash160(hexToBin(pubHex))));

/** In-memory bus modelling a Nostr relay's store-and-forward: a message sent to a
 *  peer that hasn't subscribed yet is buffered and flushed when it does — so the
 *  protocol works regardless of who connects first (as with real relays). */
type Handler = (from: string, msg: RoundMessage) => void;
class Hub {
  private handlers = new Map<string, Handler[]>();
  private mailbox = new Map<string, Array<[string, RoundMessage]>>();
  readonly sent: Array<{ from: string; to: string; message: RoundMessage }> = [];

  constructor(
    private readonly transform?: (
      from: string,
      to: string,
      message: RoundMessage
    ) => RoundMessage
  ) {}

  activeHandlerCount(): number {
    return [...this.handlers.values()].reduce(
      (count, handlers) => count + handlers.length,
      0
    );
  }

  transportFor(me: string): RoundTransport {
    return {
      send: async (to, msg) => {
        const message = this.transform?.(me, to, msg) ?? msg;
        this.sent.push({ from: me, to, message });
        const hs = this.handlers.get(to);
        if (hs && hs.length) {
          for (const h of hs) queueMicrotask(() => h(me, message));
        } else {
          const box = this.mailbox.get(to) ?? [];
          box.push([me, message]);
          this.mailbox.set(to, box);
        }
      },
      onMessage: (handler) => {
        this.handlers.set(me, [...(this.handlers.get(me) ?? []), handler]);
        const buffered = this.mailbox.get(me) ?? [];
        this.mailbox.set(me, []);
        for (const [from, msg] of buffered) queueMicrotask(() => handler(from, msg));
        return () => this.handlers.set(me, (this.handlers.get(me) ?? []).filter((h) => h !== handler));
      },
    };
  }
}

function makePeers(count = 2) {
  return Array.from({ length: count }, (_, index) => {
    const n = index + 1;
    const inKey = keypair(n * 10 + 1);
    const outKey = keypair(n * 10 + 2);
    const round = keypair(n * 10 + 3);
    const contribution: PeerContribution = {
      inputs: [
        {
          prevTxid: `${n}${'a'.repeat(63)}`,
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
        [round.pubHex, round.priv], // needed for onion peeling
      ]),
      contribution,
    };
  });
}

function txidOf(txHex: string): string {
  return binToHex(sha256.hash(sha256.hash(hexToBin(txHex))).reverse());
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('P2P fusion round choreography (3 peers, in-memory)', () => {
  it('all peers converge on a single broadcast, VM-valid CoinJoin', async () => {
    // Three peers, each fusing one 100k coin into one fresh 99.6k output (fee 400 each).
    const peers = [1, 2, 3].map((n) => {
      const inKey = keypair(n * 10 + 1);
      const outKey = keypair(n * 10 + 2);
      const round = keypair(n * 10 + 3); // pool/announce ephemeral identity
      const contribution: PeerContribution = {
        inputs: [{ prevTxid: `${n}${'a'.repeat(63)}`, prevIndex: n, value: 100_000, pubkey: inKey.pubHex }],
        outputs: [{ script: p2pkhHex(outKey.pubHex), value: 99_600 }],
      };
      return { round, keys: new Map([[inKey.pubHex, inKey.priv], [round.pubHex, round.priv]]), contribution };
    });

    const participants = peers.map((p) => p.round.pubHex);
    const hub = new Hub();
    let broadcasts = 0;
    const broadcast = async (txHex: string): Promise<string> => {
      broadcasts += 1;
      const decoded = decodeTransaction(hexToBin(txHex));
      if (typeof decoded === 'string') throw new Error(decoded);
      return binToHex(sha256.hash(sha256.hash(hexToBin(txHex))).reverse());
    };

    const results = await Promise.all(
      peers.map((p) => {
        const params: RoundParams = {
          myPubkey: p.round.pubHex,
          participants,
          tier: 100_000,
          feerate: 1000,
          onionEnabled: false,
          myContribution: p.contribution,
          keysByPubkey: p.keys,
          broadcast,
          timeoutMs: 5000,
          jitterMs: [0, 0],
        };
        return runFusionRound(params, hub.transportFor(p.round.pubHex));
      })
    );

    // Every peer resolved to the SAME transaction, broadcast exactly once.
    const txids = new Set(results.map((r) => r.txid));
    expect(txids.size).toBe(1);
    const txHexes = new Set(results.map((r) => r.txHex));
    expect(txHexes.size).toBe(1);
    expect(broadcasts).toBe(1);

    // The merged, multi-party-signed tx passes libauth's consensus VM.
    const finalHex = results[0].txHex;
    const decoded = decodeTransaction(hexToBin(finalHex)) as TransactionCommon;
    const allContribs: PeerContribution[] = peers.map((p) => p.contribution);
    const { sourceOutputs } = toLibauthTx(assembleFusionTx(allContribs));
    const vm = createVirtualMachineBCH2023();
    expect(vm.verify({ transaction: decoded, sourceOutputs })).toBe(true);

    // Sanity: 3 inputs + 3 outputs actually got fused together.
    expect(decoded.inputs).toHaveLength(3);
    expect(decoded.outputs).toHaveLength(3);
    expect(hub.activeHandlerCount()).toBe(0);
  });

  it('routes outputs through the onion mix-net and still lands a VM-valid CoinJoin', async () => {
    // Same round as above, but with the mix-net on. Until this existed the whole
    // peel/shuffle/forward path was unexercised — `onionEnabled` was never set
    // by any test or by production, so none of it had ever run.
    const peers = [1, 2, 3].map((n) => {
      const inKey = keypair(n * 10 + 1);
      const outKey = keypair(n * 10 + 2);
      const round = keypair(n * 10 + 3);
      const contribution: PeerContribution = {
        inputs: [{ prevTxid: `${n}${'a'.repeat(63)}`, prevIndex: n, value: 100_000, pubkey: inKey.pubHex }],
        outputs: [{ script: p2pkhHex(outKey.pubHex), value: 99_600 }],
      };
      return { round, keys: new Map([[inKey.pubHex, inKey.priv], [round.pubHex, round.priv]]), contribution };
    });

    const participants = peers.map((p) => p.round.pubHex);
    const coordinator = coordinatorOf(participants);
    const hub = new Hub();
    let broadcasts = 0;
    const broadcast = async (txHex: string): Promise<string> => {
      broadcasts += 1;
      return txidOf(txHex);
    };

    const results = await Promise.all(
      peers.map((p) =>
        runFusionRound(
          {
            myPubkey: p.round.pubHex,
            participants,
            tier: 100_000,
            feerate: 1000,
            myContribution: p.contribution,
            keysByPubkey: p.keys,
            broadcast,
            timeoutMs: 5000,
            jitterMs: [0, 0],
            onionEnabled: true,
          },
          hub.transportFor(p.round.pubHex)
        )
      )
    );

    // The mix-net actually carried the outputs — not a silent fall back to
    // plaintext, which is how this used to pass without running at all.
    const onionSends = hub.sent.filter((m) => m.message.type === 'onion_output');
    expect(onionSends.length).toBeGreaterThan(0);
    const declares = hub.sent.filter((m) => m.message.type === 'onion_declare');
    expect(declares.length).toBeGreaterThan(0);

    // The coordinator assembles, it does not peel: it must never appear in a
    // mix order.
    for (const send of onionSends) {
      const { mixOrder } = send.message as { mixOrder: string[] };
      expect(mixOrder).not.toContain(coordinator);
    }

    // And the round still converges on one VM-valid transaction.
    expect(new Set(results.map((r) => r.txid)).size).toBe(1);
    expect(broadcasts).toBe(1);

    const decodedOnion = decodeTransaction(hexToBin(results[0].txHex)) as TransactionCommon;
    const { sourceOutputs: onionSources } = toLibauthTx(
      assembleFusionTx(peers.map((p) => p.contribution))
    );
    const onionVm = createVirtualMachineBCH2023();
    expect(onionVm.verify({ transaction: decodedOnion, sourceOutputs: onionSources })).toBe(true);
    expect(decodedOnion.inputs).toHaveLength(3);
    expect(decodedOnion.outputs).toHaveLength(3);
    expect(hub.activeHandlerCount()).toBe(0);
  });

  it('2-peer rounds complete with onionEnabled (falls back to direct — no self-peel)', async () => {
    // Production bug: 2 peers ⇒ 1 peeler gift-wrapping onions to themselves over
    // Nostr ⇒ never delivered ⇒ outputSlots=0/2. Direct path is correct here.
    const peers = [1, 2].map((n) => {
      const inKey = keypair(n * 10 + 1);
      const outKey = keypair(n * 10 + 2);
      const round = keypair(n * 10 + 3);
      return {
        round,
        keys: new Map([
          [inKey.pubHex, inKey.priv],
          [round.pubHex, round.priv],
        ]),
        contribution: {
          inputs: [
            {
              prevTxid: `${n}${'d'.repeat(63)}`,
              prevIndex: n,
              value: 100_000,
              pubkey: inKey.pubHex,
            },
          ],
          outputs: [{ script: p2pkhHex(outKey.pubHex), value: 99_700 }],
        } as PeerContribution,
      };
    });
    const participants = peers.map((p) => p.round.pubHex);
    const hub = new Hub();
    let broadcasts = 0;
    const results = await Promise.all(
      peers.map((p) =>
        runFusionRound(
          {
            myPubkey: p.round.pubHex,
            participants,
            tier: 100_000,
            feerate: 1000,
            myContribution: p.contribution,
            keysByPubkey: p.keys,
            broadcast: async (txHex) => {
              broadcasts += 1;
              return txidOf(txHex);
            },
            timeoutMs: 5_000,
            jitterMs: [0, 0],
            onionEnabled: true,
          },
          hub.transportFor(p.round.pubHex)
        )
      )
    );
    expect(new Set(results.map((r) => r.txid)).size).toBe(1);
    expect(broadcasts).toBe(1);
    // No onion path for 2-party (would be self-addressed).
    const onions = hub.sent.filter((m) => m.message.type === 'onion_output');
    expect(onions).toHaveLength(0);
  });

  it('onion mix-net completes when peers inject unequal output counts (not peer count)', async () => {
    // Regression: expectedOnionCount === participants.length hung whenever
    // sum(outputs) !== N (random 2–4 outputs/peer from planP2pOutputValues).
    const peers = [1, 2, 3].map((n) => {
      const inKey = keypair(n * 10 + 1);
      const outA = keypair(n * 10 + 2);
      const outB = keypair(n * 10 + 3);
      const round = keypair(n * 10 + 4);
      const outCount = n; // 1, 2, 3 — sum 6 ≠ 3 peers
      const perOut = Math.floor(99_500 / outCount);
      const outputs = Array.from({ length: outCount }, (_, i) => ({
        script: p2pkhHex(i === 0 ? outA.pubHex : outB.pubHex),
        value: perOut,
      }));
      // Burn remainder into first output so fee stays sane.
      outputs[0].value += 99_500 - perOut * outCount;
      const contribution: PeerContribution = {
        inputs: [
          {
            prevTxid: `${n}${'b'.repeat(63)}`,
            prevIndex: n,
            value: 100_000,
            pubkey: inKey.pubHex,
          },
        ],
        outputs,
      };
      return {
        round,
        keys: new Map([
          [inKey.pubHex, inKey.priv],
          [round.pubHex, round.priv],
        ]),
        contribution,
      };
    });
    const participants = peers.map((p) => p.round.pubHex);
    const hub = new Hub();
    let broadcasts = 0;
    const results = await Promise.all(
      peers.map((p) =>
        runFusionRound(
          {
            myPubkey: p.round.pubHex,
            participants,
            tier: 100_000,
            feerate: 1000,
            myContribution: p.contribution,
            keysByPubkey: p.keys,
            broadcast: async (txHex) => {
              broadcasts += 1;
              return txidOf(txHex);
            },
            timeoutMs: 8_000,
            jitterMs: [0, 0],
            onionEnabled: true,
          },
          hub.transportFor(p.round.pubHex)
        )
      )
    );
    expect(new Set(results.map((r) => r.txid)).size).toBe(1);
    expect(broadcasts).toBe(1);
    const totalOutputs = peers.reduce((s, p) => s + p.contribution.outputs.length, 0);
    expect(totalOutputs).toBe(6);
    const decoded = decodeTransaction(hexToBin(results[0].txHex)) as TransactionCommon;
    expect(decoded.outputs).toHaveLength(6);
  });

  it('coordinator VM-validates every peer signature before broadcast', async () => {
    const peers = makePeers();
    const participants = peers.map((peer) => peer.round.pubHex);
    const coordinator = coordinatorOf(participants);
    const hub = new Hub((from, to, message) => {
      if (
        to === coordinator &&
        from !== coordinator &&
        message.type === 'signature'
      ) {
        return {
          ...message,
          sigs: message.sigs.map((signature) => ({
            ...signature,
            unlockingBytecode: `00${signature.unlockingBytecode.slice(2)}`,
          })),
        };
      }
      return message;
    });
    let broadcasts = 0;

    const settled = await Promise.allSettled(
      peers.map((peer) =>
        runFusionRound(
          {
            myPubkey: peer.round.pubHex,
            participants,
            tier: 100_000,
            feerate: 1_000,
            onionEnabled: false,
            myContribution: peer.contribution,
            keysByPubkey: peer.keys,
            broadcast: async (txHex) => {
              broadcasts += 1;
              return txidOf(txHex);
            },
            timeoutMs: 1_000,
            jitterMs: [0, 0],
          },
          hub.transportFor(peer.round.pubHex)
        )
      )
    );

    expect(broadcasts).toBe(0);
    expect(settled.every((result) => result.status === 'rejected')).toBe(true);
    expect(
      settled.some(
        (result) =>
          result.status === 'rejected' &&
          /failed BCH validation/i.test(String(result.reason))
      )
    ).toBe(true);
    expect(hub.activeHandlerCount()).toBe(0);
  });

  it('does not broadcast when cancellation wins immediately before broadcast', async () => {
    const peers = makePeers();
    const participants = peers.map((peer) => peer.round.pubHex);
    const coordinator = coordinatorOf(participants);
    const controller = new AbortController();
    const hub = new Hub();
    let broadcasts = 0;

    const settled = await Promise.allSettled(
      peers.map((peer) =>
        runFusionRound(
          {
            myPubkey: peer.round.pubHex,
            participants,
            tier: 100_000,
            feerate: 1_000,
            onionEnabled: false,
            myContribution: peer.contribution,
            keysByPubkey: peer.keys,
            broadcast: async (txHex) => {
              broadcasts += 1;
              return txidOf(txHex);
            },
            signal:
              peer.round.pubHex === coordinator
                ? controller.signal
                : undefined,
            onPhase:
              peer.round.pubHex === coordinator
                ? (phase) => {
                    if (phase === 5) controller.abort();
                  }
                : undefined,
            timeoutMs: 1_000,
            jitterMs: [0, 0],
          },
          hub.transportFor(peer.round.pubHex)
        )
      )
    );

    expect(broadcasts).toBe(0);
    expect(settled.every((result) => result.status === 'rejected')).toBe(true);
    expect(hub.activeHandlerCount()).toBe(0);
  });

  it('resolves a successful in-flight broadcast even if cancellation arrives', async () => {
    const peers = makePeers();
    const participants = peers.map((peer) => peer.round.pubHex);
    const coordinator = coordinatorOf(participants);
    const controller = new AbortController();
    const pending = deferred<string>();
    const hub = new Hub();
    let broadcastHex = '';
    let broadcastStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      broadcastStarted = resolve;
    });

    const promises = peers.map((peer) =>
      runFusionRound(
        {
          myPubkey: peer.round.pubHex,
          participants,
          tier: 100_000,
          feerate: 1_000,
          onionEnabled: false,
          myContribution: peer.contribution,
          keysByPubkey: peer.keys,
          broadcast: async (txHex) => {
            broadcastHex = txHex;
            broadcastStarted();
            return pending.promise;
          },
          signal:
            peer.round.pubHex === coordinator ? controller.signal : undefined,
          timeoutMs: 1_000,
          jitterMs: [0, 0],
        },
        hub.transportFor(peer.round.pubHex)
      )
    );

    await started;
    controller.abort();
    pending.resolve(txidOf(broadcastHex));

    const results = await Promise.all(promises);
    expect(new Set(results.map((result) => result.txid)).size).toBe(1);
    expect(hub.activeHandlerCount()).toBe(0);
    expect(
      hub.sent.some((entry) => entry.message.type === 'abort')
    ).toBe(false);
  });

  it('rejects truthfully when an in-flight broadcast fails after cancellation', async () => {
    const peers = makePeers();
    const participants = peers.map((peer) => peer.round.pubHex);
    const coordinator = coordinatorOf(participants);
    const controller = new AbortController();
    const pending = deferred<string>();
    const hub = new Hub();
    let broadcastStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      broadcastStarted = resolve;
    });

    const settledPromise = Promise.allSettled(
      peers.map((peer) =>
        runFusionRound(
          {
            myPubkey: peer.round.pubHex,
            participants,
            tier: 100_000,
            feerate: 1_000,
            onionEnabled: false,
            myContribution: peer.contribution,
            keysByPubkey: peer.keys,
            broadcast: async () => {
              broadcastStarted();
              return pending.promise;
            },
            signal:
              peer.round.pubHex === coordinator
                ? controller.signal
                : undefined,
            timeoutMs: 1_000,
            jitterMs: [0, 0],
          },
          hub.transportFor(peer.round.pubHex)
        )
      )
    );

    // `started` is the promise; `broadcastStarted` is its resolver. Awaiting the
    // resolver is a no-op, so this raced ahead and aborted before the broadcast
    // was ever in flight — the very state the test claims to exercise.
    await started;
    controller.abort();
    pending.reject(new Error('broadcast rejected'));

    const settled = await settledPromise;
    expect(settled.every((result) => result.status === 'rejected')).toBe(true);
    expect(
      settled.some(
        (result) =>
          result.status === 'rejected' &&
          /broadcast rejected/i.test(String(result.reason))
      )
    ).toBe(true);
    expect(hub.activeHandlerCount()).toBe(0);
  });

  it('broadcasts an abort so duplicate inputs fail every peer promptly', async () => {
    const peers = [1, 2].map((n) => {
      const inKey = keypair(n * 10 + 1);
      const outKey = keypair(n * 10 + 2);
      const round = keypair(n * 10 + 3);
      const contribution: PeerContribution = {
        inputs: [
          {
            prevTxid: 'd'.repeat(64),
            prevIndex: 0,
            value: 100_000,
            pubkey: inKey.pubHex,
          },
        ],
        outputs: [{ script: p2pkhHex(outKey.pubHex), value: 99_600 }],
      };
      return { round, keys: new Map([[inKey.pubHex, inKey.priv], [round.pubHex, round.priv]]), contribution };
    });
    const participants = peers.map((item) => item.round.pubHex);
    const hub = new Hub();

    const settled = await Promise.allSettled(
      peers.map((item) =>
        runFusionRound(
          {
            myPubkey: item.round.pubHex,
            participants,
            session: 'a'.repeat(64),
            tier: 100_000,
            feerate: 1_000,
            onionEnabled: false,
            myContribution: item.contribution,
            keysByPubkey: item.keys,
            broadcast: async () => {
              throw new Error('must not broadcast');
            },
            timeoutMs: 250,
            jitterMs: [0, 0],
          },
          hub.transportFor(item.round.pubHex)
        )
      )
    );

    expect(settled).toHaveLength(2);
    for (const result of settled) {
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') {
        expect(String(result.reason)).toContain('duplicate input');
      }
    }
  });

  it('rejects a coordinator final message that was not the verified transaction', async () => {
    const input = keypair(71);
    const output = keypair(72);
    // Roles come from the election, not from pubkey order: this test only
    // works while `myPubkey` is the one NOT coordinating, or it runs the
    // coordinator path and simply times out waiting for a peer.
    const coordinator = coordinatorOf(['0'.repeat(64), 'f'.repeat(64)]);
    const participant = coordinator === '0'.repeat(64) ? 'f'.repeat(64) : '0'.repeat(64);
    const session = 'b'.repeat(64);
    const contribution: PeerContribution = {
      inputs: [
        {
          prevTxid: 'e'.repeat(64),
          prevIndex: 1,
          value: 100_000,
          pubkey: input.pubHex,
        },
      ],
      outputs: [{ script: p2pkhHex(output.pubHex), value: 99_600 }],
    };
    // Mock coordinator must also play the credential issuer, or the
    // participant never leaves the wait-for-params gate.
    const { BlindIssuer } = await import('../fusionBlindSchnorr');
    const issuer = BlindIssuer.create(32);
    let handler: Handler = () => undefined;
    const transport: RoundTransport = {
      send: async (_to, message) => {
        if (message.type === 'credential_request') {
          queueMicrotask(() =>
            handler(coordinator, {
              ...messageBinding(),
              type: 'credential_response',
              session,
              responses: message.requests.map((r) => ({
                index: r.index,
                s: issuer.signHex(r.index, r.e),
              })),
            })
          );
        }
        if (message.type === 'outputs') {
          queueMicrotask(() =>
            handler(coordinator, {
              ...messageBinding(),
              type: 'assembled',
              session,
              inputs: contribution.inputs,
              outputs: contribution.outputs,
            })
          );
        }
        if (message.type === 'signature') {
          queueMicrotask(() =>
            handler(coordinator, {
              ...messageBinding(),
              type: 'final',
              session,
              txid: '00'.repeat(32),
              txHex: '00',
            })
          );
        }
      },
      onMessage: (next) => {
        handler = next;
        queueMicrotask(() =>
          handler(coordinator, {
            ...messageBinding(),
            type: 'credential_params',
            session,
            roundPubkey: issuer.pubkeyHex,
            blindNoncePoints: issuer.rPointsHex,
          })
        );
        return () => undefined;
      },
    };

    await expect(
      runFusionRound(
        {
          myPubkey: participant,
          participants: [coordinator, participant],
          session,
          tier: 100_000,
          feerate: 1_000,
          onionEnabled: false,
          myContribution: contribution,
          keysByPubkey: new Map([[input.pubHex, input.priv]]),
          broadcast: async () => {
            throw new Error('participant must not broadcast');
          },
          timeoutMs: 1_000,
          jitterMs: [0, 0],
        },
        transport
      )
    ).rejects.toThrow(/final Fusion transaction/i);
  });

  it('fails immediately when the authenticated coordinator sends a malformed message', async () => {
    const input = keypair(81);
    const output = keypair(82);
    const coordinator = '0'.repeat(64);
    const participant = 'f'.repeat(64);
    const contribution: PeerContribution = {
      inputs: [
        {
          prevTxid: '9'.repeat(64),
          prevIndex: 0,
          value: 100_000,
          pubkey: input.pubHex,
        },
      ],
      outputs: [{ script: p2pkhHex(output.pubHex), value: 99_600 }],
    };
    const transport: RoundTransport = {
      send: async () => undefined,
      onMessage: () => () => undefined,
      onProtocolError: (handler) => {
        queueMicrotask(() =>
          handler(coordinator, new Error('Invalid Fusion round message.'))
        );
        return () => undefined;
      },
    };

    await expect(
      runFusionRound(
        {
          myPubkey: participant,
          participants: [coordinator, participant],
          session: 'c'.repeat(64),
          tier: 100_000,
          feerate: 1_000,
          onionEnabled: false,
          myContribution: contribution,
          keysByPubkey: new Map([[input.pubHex, input.priv]]),
          broadcast: async () => '',
          timeoutMs: 50,
          jitterMs: [0, 0],
        },
        transport
      )
    ).rejects.toThrow('Invalid Fusion round message');
  });
});
