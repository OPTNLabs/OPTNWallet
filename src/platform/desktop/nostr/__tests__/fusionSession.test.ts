import { describe, expect, it, vi } from 'vitest';
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
  runFusionRound,
  type RoundMessage,
  type RoundTransport,
  type RoundParams,
} from '../fusionSession';
import { assembleFusionTx, type PeerContribution } from '../fusionRound';
import type { BlameReport } from '../fusionBlame';
import { electCoordinator } from '../fusion';
import { signMyInputs, toLibauthTx } from '../fusionSign';
import { pedersenCommit, sumNoncesHex } from '../fusionPedersen';

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
const p2pkhHex = (pubHex: string) =>
  binToHex(encodeLockingBytecodeP2pkh(hash160(hexToBin(pubHex))));

/** In-memory bus modelling a Nostr relay's store-and-forward: a message sent to a
 *  peer that hasn't subscribed yet is buffered and flushed when it does — so the
 *  protocol works regardless of who connects first (as with real relays). */
type Handler = (from: string, msg: RoundMessage) => void;
/**
 * A distinct one-time 64-hex sender per anonymous component, standing in for
 * production's `generateSecretKey()` seal. Distinct per call on purpose: a
 * single shared fake would still let the coordinator group components.
 */
let anonymousSenderCounter = 0;
const anonymousSender = (): string =>
  (++anonymousSenderCounter).toString(16).padStart(64, 'a');

class Hub {
  private handlers = new Map<string, Handler[]>();
  private mailbox = new Map<string, Array<[string, RoundMessage]>>();
  readonly sent: Array<{ from: string; to: string; message: RoundMessage }> =
    [];

  /**
   * `transform` may rewrite a message, or return `null`/`undefined` to DROP it
   * — which is how a test models a peer that goes silent (withholds its
   * signatures) rather than one that lies. A relay cannot be asked to deliver
   * something a peer never sent, so silence has to be expressible here.
   */
  constructor(
    private readonly transform?: (
      from: string,
      to: string,
      message: RoundMessage
    ) => RoundMessage | null | undefined
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
        const next = this.transform?.(me, to, msg);
        // A missing transform yields `undefined` too, so only treat nullish as
        // "drop" when a transform is actually installed.
        if (this.transform && next == null) return;
        const message = next ?? msg;
        this.sent.push({ from: me, to, message });
        // Model production: fusionTransport seals every COMPONENT under a
        // fresh generateSecretKey(), so `from` is a one-time pubkey the
        // coordinator cannot attribute — and a DIFFERENT one per component, so
        // it cannot group them either. Control-plane messages keep the real
        // round identity. A Hub that delivered `me` for components would let an
        // `others.includes(from)` check pass in tests and fail in production,
        // which is exactly how the original participants.includes(from) bug
        // shipped green.
        const deliveredFrom =
          message.type === 'outputs' ||
          message.type === 'onion_output' ||
          message.type === 'inputs' ||
          message.type === 'signature'
            ? anonymousSender()
            : me;
        const hs = this.handlers.get(to);
        if (hs && hs.length) {
          for (const h of hs) queueMicrotask(() => h(deliveredFrom, message));
        } else {
          const box = this.mailbox.get(to) ?? [];
          box.push([deliveredFrom, message]);
          this.mailbox.set(to, box);
        }
      },
      onMessage: (handler) => {
        this.handlers.set(me, [...(this.handlers.get(me) ?? []), handler]);
        const buffered = this.mailbox.get(me) ?? [];
        this.mailbox.set(me, []);
        for (const [from, msg] of buffered)
          queueMicrotask(() => handler(from, msg));
        return () =>
          this.handlers.set(
            me,
            (this.handlers.get(me) ?? []).filter((h) => h !== handler)
          );
      },
    };
  }
}

function makePeers(count = 3) {
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
          [round.pubHex, round.priv],
        ]),
        contribution,
      };
    });

    const participants = peers.map((p) => p.round.pubHex);
    const hub = new Hub();
    let broadcasts = 0;
    const signingBoundary = vi.fn(
      async (
        tx: ReturnType<typeof assembleFusionTx>,
        keys: Map<string, Uint8Array>
      ) => signMyInputs(tx, keys)
    );
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
          myContribution: p.contribution,
          keysByPubkey: p.keys,
          sign: (tx) => signingBoundary(tx, p.keys),
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
    expect(signingBoundary).toHaveBeenCalledTimes(peers.length);

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
    // peel/shuffle/forward path — onion is hardcoded essential for 3+ peers
    // by any test or by production, so none of it had ever run.
    const peers = [1, 2, 3].map((n) => {
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
          [round.pubHex, round.priv],
        ]),
        contribution,
      };
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
          },
          hub.transportFor(p.round.pubHex)
        )
      )
    );

    // The mix-net actually carried the outputs — not a silent fall back to
    // plaintext, which is how this used to pass without running at all.
    const onionSends = hub.sent.filter(
      (m) => m.message.type === 'onion_output'
    );
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

    const decodedOnion = decodeTransaction(
      hexToBin(results[0].txHex)
    ) as TransactionCommon;
    const { sourceOutputs: onionSources } = toLibauthTx(
      assembleFusionTx(peers.map((p) => p.contribution))
    );
    const onionVm = createVirtualMachineBCH2023();
    expect(
      onionVm.verify({ transaction: decodedOnion, sourceOutputs: onionSources })
    ).toBe(true);
    expect(decodedOnion.inputs).toHaveLength(3);
    expect(decodedOnion.outputs).toHaveLength(3);
    expect(hub.activeHandlerCount()).toBe(0);
  });

  it('rejects rounds with fewer than 3 participants (no 2-party path)', async () => {
    const peers = makePeers(2);
    const participants = peers.map((p) => p.round.pubHex);
    const hub = new Hub();
    await expect(
      runFusionRound(
        {
          myPubkey: peers[0].round.pubHex,
          participants,
          tier: 100_000,
          feerate: 1000,
          myContribution: peers[0].contribution,
          keysByPubkey: peers[0].keys,
          broadcast: async () => '00'.repeat(32),
          timeoutMs: 500,
          jitterMs: [0, 0],
        },
        hub.transportFor(peers[0].round.pubHex)
      )
    ).rejects.toThrow(/≥3 peers|at least 3/i);
  });

  it('onion mix-net completes when peers inject unequal output counts (not peer count)', async () => {
    // Regression: expectedOnionCount === participants.length hung whenever
    // sum(outputs) !== N (random 2–4 outputs/peer from planP2pOutputValues).
    const peers = [1, 2, 3].map((n) => {
      const inKey = keypair(n * 10 + 1);
      const outputKeys = Array.from({ length: n }, (_, i) =>
        keypair(n * 100 + i + 2)
      );
      const round = keypair(n * 10 + 4);
      const outCount = n; // 1, 2, 3 — sum 6 ≠ 3 peers
      const perOut = Math.floor(99_500 / outCount);
      const outputs = Array.from({ length: outCount }, (_, i) => ({
        script: p2pkhHex(outputKeys[i].pubHex),
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
          },
          hub.transportFor(p.round.pubHex)
        )
      )
    );
    expect(new Set(results.map((r) => r.txid)).size).toBe(1);
    expect(broadcasts).toBe(1);
    const totalOutputs = peers.reduce(
      (s, p) => s + p.contribution.outputs.length,
      0
    );
    expect(totalOutputs).toBe(6);
    const decoded = decodeTransaction(
      hexToBin(results[0].txHex)
    ) as TransactionCommon;
    expect(decoded.outputs).toHaveLength(6);
  });

  it('forwards a full four-peer onion batch without serially exhausting the round deadline', async () => {
    const peers = [1, 2, 3, 4].map((n) => {
      const inKey = keypair(n * 10 + 1);
      const outputKeys = Array.from({ length: 4 }, (_, i) =>
        keypair(n * 100 + i + 2)
      );
      const round = keypair(n * 10 + 6);
      const outputs = outputKeys.map((outputKey) => ({
        script: p2pkhHex(outputKey.pubHex),
        value: 24_875,
      }));
      const contribution: PeerContribution = {
        inputs: [
          {
            prevTxid: `${n}${'c'.repeat(63)}`,
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
    const participants = peers.map((peer) => peer.round.pubHex);
    const coordinator = coordinatorOf(participants);
    const mixOrder = participants.filter((peer) => peer !== coordinator).sort();
    const hub = new Hub();
    let activeForwardSends = 0;
    let maxConcurrentForwardSends = 0;

    const results = await Promise.all(
      peers.map((peer) => {
        const base = hub.transportFor(peer.round.pubHex);
        const transport: RoundTransport =
          peer.round.pubHex === mixOrder[0]
            ? {
                ...base,
                send: async (to, message) => {
                  if (to === mixOrder[1] && message.type === 'onion_output') {
                    activeForwardSends += 1;
                    maxConcurrentForwardSends = Math.max(
                      maxConcurrentForwardSends,
                      activeForwardSends
                    );
                    try {
                      await new Promise((resolve) => setTimeout(resolve, 100));
                    } finally {
                      activeForwardSends -= 1;
                    }
                  }
                  return base.send(to, message);
                },
              }
            : base;
        return runFusionRound(
          {
            myPubkey: peer.round.pubHex,
            participants,
            network: 'chipnet',
            tier: 100_000,
            feerate: 1_000,
            myContribution: peer.contribution,
            keysByPubkey: peer.keys,
            broadcast: async (txHex) => txidOf(txHex),
            timeoutMs: 1_200,
            jitterMs: [0, 0],
          },
          transport
        );
      })
    );

    expect(maxConcurrentForwardSends).toBeGreaterThan(1);
    expect(new Set(results.map((result) => result.txid)).size).toBe(1);
    expect(hub.activeHandlerCount()).toBe(0);
  }, 10_000);

  it('re-sends a shuffled hop batch when one forward blob is lost', async () => {
    const peers = makePeers();
    const participants = peers.map((peer) => peer.round.pubHex);
    const coordinator = coordinatorOf(participants);
    const mixOrder = participants.filter((peer) => peer !== coordinator).sort();
    let dropped = false;
    const hub = new Hub((from, to, message) => {
      if (
        !dropped &&
        from === mixOrder[0] &&
        to === mixOrder[1] &&
        message.type === 'onion_output'
      ) {
        dropped = true;
        return null;
      }
      return message;
    });

    const results = await Promise.all(
      peers.map((peer) =>
        runFusionRound(
          {
            myPubkey: peer.round.pubHex,
            participants,
            network: 'chipnet',
            tier: 100_000,
            feerate: 1_000,
            myContribution: peer.contribution,
            keysByPubkey: peer.keys,
            broadcast: async (txHex) => txidOf(txHex),
            timeoutMs: 8_000,
            jitterMs: [0, 0],
          },
          hub.transportFor(peer.round.pubHex)
        )
      )
    );

    expect(dropped).toBe(true);
    expect(new Set(results.map((result) => result.txid)).size).toBe(1);
  }, 12_000);

  it('does not announce ready after an initial onion injection publish fails', async () => {
    const peers = makePeers();
    const participants = peers.map((peer) => peer.round.pubHex);
    const coordinator = coordinatorOf(participants);
    const firstPeeler = participants
      .filter((peer) => peer !== coordinator)
      .sort()[0];
    const failingPeer = peers.find(
      (peer) =>
        peer.round.pubHex !== coordinator && peer.round.pubHex !== firstPeeler
    );
    if (!failingPeer)
      throw new Error('test requires a remote-injecting participant');
    const hub = new Hub();
    const settled = await Promise.allSettled(
      peers.map((peer) => {
        const base = hub.transportFor(peer.round.pubHex);
        const transport: RoundTransport =
          peer === failingPeer
            ? {
                ...base,
                send: async (to, message) => {
                  if (message.type === 'onion_output') {
                    throw new Error('all relays rejected component');
                  }
                  return base.send(to, message);
                },
              }
            : base;
        return runFusionRound(
          {
            myPubkey: peer.round.pubHex,
            participants,
            network: 'chipnet',
            tier: 100_000,
            feerate: 1_000,
            myContribution: peer.contribution,
            keysByPubkey: peer.keys,
            broadcast: async (txHex) => txidOf(txHex),
            timeoutMs: 1_000,
            jitterMs: [0, 0],
          },
          transport
        );
      })
    );

    expect(settled.some((result) => result.status === 'rejected')).toBe(true);
    expect(
      hub.sent.some(
        (sent) =>
          sent.from === failingPeer.round.pubHex &&
          sent.message.type === 'components_ready'
      )
    ).toBe(false);
  });

  it('rejects a malicious final peeler that alters an authorized output', async () => {
    const peers = makePeers();
    const participants = peers.map((peer) => peer.round.pubHex);
    const coordinator = coordinatorOf(participants);
    let altered = false;
    const hub = new Hub((from, to, message) => {
      if (!altered && to === coordinator && message.type === 'outputs') {
        altered = true;
        return {
          ...message,
          outputs: message.outputs.map((output, index) =>
            index === 0
              ? {
                  ...output,
                  credentialSig: `${output.credentialSig.slice(0, -2)}${
                    output.credentialSig.endsWith('00') ? '01' : '00'
                  }`,
                }
              : output
          ),
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
            network: 'chipnet',
            tier: 100_000,
            feerate: 1_000,
            myContribution: peer.contribution,
            keysByPubkey: peer.keys,
            broadcast: async (txHex) => {
              broadcasts += 1;
              return txidOf(txHex);
            },
            timeoutMs: 1_500,
            jitterMs: [0, 0],
          },
          hub.transportFor(peer.round.pubHex)
        )
      )
    );

    expect(altered).toBe(true);
    expect(broadcasts).toBe(0);
    expect(settled.every((result) => result.status === 'rejected')).toBe(true);
    expect(
      settled.some(
        (result) =>
          result.status === 'rejected' &&
          /output credential|protocol fault/i.test(String(result.reason))
      )
    ).toBe(true);
    expect(hub.activeHandlerCount()).toBe(0);
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
            myContribution: peer.contribution,
            keysByPubkey: peer.keys,
            broadcast: async (txHex) => {
              broadcasts += 1;
              return txidOf(txHex);
            },
            signal:
              peer.round.pubHex === coordinator ? controller.signal : undefined,
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
    expect(hub.sent.some((entry) => entry.message.type === 'abort')).toBe(
      false
    );
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
            myContribution: peer.contribution,
            keysByPubkey: peer.keys,
            broadcast: async () => {
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
    // Three peers; two share the same outpoint so the coord aborts on duplicate.
    const peers = [1, 2, 3].map((n) => {
      const inKey = keypair(n * 10 + 1);
      const outKey = keypair(n * 10 + 2);
      const round = keypair(n * 10 + 3);
      const contribution: PeerContribution = {
        inputs: [
          {
            prevTxid: n <= 2 ? 'd'.repeat(64) : `${n}${'e'.repeat(63)}`,
            prevIndex: n <= 2 ? 0 : n,
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
          [round.pubHex, round.priv],
        ]),
        contribution,
      };
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
            myContribution: item.contribution,
            keysByPubkey: item.keys,
            broadcast: async () => {
              throw new Error('must not broadcast');
            },
            timeoutMs: 2_000,
            jitterMs: [0, 0],
          },
          hub.transportFor(item.round.pubHex)
        )
      )
    );

    expect(settled).toHaveLength(3);
    expect(settled.every((r) => r.status === 'rejected')).toBe(true);
    expect(
      settled.some(
        (r) =>
          r.status === 'rejected' &&
          /duplicate (input|outpoint)|Protocol fault/i.test(String(r.reason))
      )
    ).toBe(true);
  });

  it('fails immediately when the authenticated coordinator sends a malformed message', async () => {
    const input = keypair(81);
    const output = keypair(82);
    const trio = ['0'.repeat(64), 'a'.repeat(64), 'f'.repeat(64)];
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
          participants: trio,
          session: 'c'.repeat(64),
          tier: 100_000,
          feerate: 1_000,
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

  // ── Option 3 blame emit (C2) ───────────────────────────────────────────────
  // Components travel under throwaway keys, so a failed round has no accused
  // until peers disclose what they contributed. These lock the coordinator's
  // post-abort cross-check. Diagnosis only: the accused is an ephemeral round
  // key, so a report identifies a fault — it never excludes anyone.

  it('names the peer that withheld its signatures, once disclosures land', async () => {
    const peers = makePeers();
    const participants = peers.map((peer) => peer.round.pubHex);
    const coordinator = coordinatorOf(participants);
    // A non-coordinator peer registers its anonymous inputs and then goes
    // silent at the signature phase — the griefer that was unattributable once
    // components stopped carrying a sender.
    const silent = participants.find((peer) => peer !== coordinator);
    if (!silent) throw new Error('no non-coordinator peer to silence');
    const hub = new Hub((from, _to, message) =>
      from === silent && message.type === 'signature' ? null : message
    );
    const blames: BlameReport[] = [];

    const settled = await Promise.allSettled(
      peers.map((peer) =>
        runFusionRound(
          {
            myPubkey: peer.round.pubHex,
            participants,
            network: 'chipnet',
            tier: 100_000,
            feerate: 1_000,
            myContribution: peer.contribution,
            keysByPubkey: peer.keys,
            broadcast: async (txHex) => txidOf(txHex),
            // E0: ONE deadline for every role, exactly as production passes it.
            // The session itself gives peers the margin — without that they all
            // tear down in the same tick, unsubscribe before the coordinator's
            // abort reaches them, and disclose nothing, so the blame phase burns
            // its whole ceiling and names no one. Skewing this per role in the
            // test would hide precisely the bug E0 fixes.
            timeoutMs: 800,
            jitterMs: [0, 0],
            onBlame: (report) => {
              if (peer.round.pubHex === coordinator) blames.push(report);
            },
          },
          hub.transportFor(peer.round.pubHex)
        )
      )
    );

    expect(settled.every((result) => result.status === 'rejected')).toBe(true);
    // The whole point: an anonymous-plane fault now has an accused again.
    expect(blames).toHaveLength(1);
    expect(blames[0].code).toBe('invalid_signature_set');
    expect(blames[0].accused).toBe(silent);
    // And it actually reached the other peers, not just the local callback.
    expect(
      hub.sent.some(
        (entry) => entry.from === coordinator && entry.message.type === 'blame'
      )
    ).toBe(true);
    expect(hub.activeHandlerCount()).toBe(0);
  });

  it('blames a peer that forges a disclosure opening (invalid_input_credential)', async () => {
    const peers = makePeers();
    const participants = peers.map((peer) => peer.round.pubHex);
    const coordinator = coordinatorOf(participants);
    const liar = participants.find((peer) => peer !== coordinator);
    if (!liar) throw new Error('no non-coordinator peer');
    const hub = new Hub((from, _to, message) => {
      // Withhold signatures so the round aborts into the blame phase.
      if (from === liar && message.type === 'signature') return null;
      // Forge the opening after credentials were issued — C4 must accuse, not drop.
      if (from === liar && message.type === 'component_disclosure') {
        return {
          ...message,
          openings: (message.openings ?? []).map((entry) => ({
            ...entry,
            openingHex: 'ab'.repeat(64),
          })),
        };
      }
      return message;
    });
    const blames: BlameReport[] = [];

    const settled = await Promise.allSettled(
      peers.map((peer) =>
        runFusionRound(
          {
            myPubkey: peer.round.pubHex,
            participants,
            network: 'chipnet',
            tier: 100_000,
            feerate: 1_000,
            myContribution: peer.contribution,
            keysByPubkey: peer.keys,
            broadcast: async (txHex) => txidOf(txHex),
            timeoutMs: 800,
            jitterMs: [0, 0],
            onBlame: (report) => {
              if (peer.round.pubHex === coordinator) blames.push(report);
            },
          },
          hub.transportFor(peer.round.pubHex)
        )
      )
    );

    expect(settled.every((result) => result.status === 'rejected')).toBe(true);
    expect(blames).toHaveLength(1);
    expect(blames[0].code).toBe('invalid_input_credential');
    expect(blames[0].accused).toBe(liar);
    expect(hub.activeHandlerCount()).toBe(0);
  });

  it('blames a peer whose balanced Pedersen commitments open to different components', async () => {
    const peers = makePeers();
    const participants = peers.map((peer) => peer.round.pubHex);
    const coordinator = coordinatorOf(participants);
    const liar = participants.find((peer) => peer !== coordinator);
    if (!liar) throw new Error('no non-coordinator peer');

    const hub = new Hub((from, _to, message) => {
      if (from === liar && message.type === 'credential_request') {
        // Keep the aggregate Pedersen equation valid while committing to
        // different per-component amounts than the blinded EC Components.
        // A separate balance-only list accepts this; an EC InitialCommitment
        // must make the mismatch provable when the peer opens on abort.
        const first = pedersenCommit(0);
        const second = pedersenCommit(message.excessFee);
        const falsifiedAmounts = [first.commitmentHex, second.commitmentHex];
        const componentCommitments = (
          message as RoundMessage & {
            componentCommitments?: Array<{
              index: number;
              saltedComponentHash: string;
              amountCommitment: string;
            }>;
          }
        ).componentCommitments?.map((commitment, index) => ({
          ...commitment,
          amountCommitment: falsifiedAmounts[index],
        }));
        return {
          ...message,
          amountCommitments: falsifiedAmounts,
          ...(componentCommitments ? { componentCommitments } : {}),
          pedersenTotalNonce: sumNoncesHex([first.nonceHex, second.nonceHex]),
        };
      }
      // Force the abort/blame phase after the coordinator has accepted and
      // signed the mismatched credential request.
      if (from === liar && message.type === 'signature') return null;
      return message;
    });
    const blames: BlameReport[] = [];

    const settled = await Promise.allSettled(
      peers.map((peer) =>
        runFusionRound(
          {
            myPubkey: peer.round.pubHex,
            participants,
            network: 'chipnet',
            tier: 100_000,
            feerate: 1_000,
            myContribution: peer.contribution,
            keysByPubkey: peer.keys,
            broadcast: async (txHex) => txidOf(txHex),
            timeoutMs: 800,
            jitterMs: [0, 0],
            onBlame: (report) => {
              if (peer.round.pubHex === coordinator) blames.push(report);
            },
          },
          hub.transportFor(peer.round.pubHex)
        )
      )
    );

    expect(settled.every((result) => result.status === 'rejected')).toBe(true);
    expect(blames).toHaveLength(1);
    expect(blames[0].code).toBe('invalid_component_commitment');
    expect(blames[0].accused).toBe(liar);
    expect(hub.activeHandlerCount()).toBe(0);
  });

  it('blames nobody and still fails fast when the round dies in the control plane', async () => {
    const peers = makePeers();
    const participants = peers.map((peer) => peer.round.pubHex);
    // No anonymous component ever reaches the coordinator, so no disclosure
    // could attribute anything. The blame window must be skipped outright.
    const hub = new Hub((_from, _to, message) =>
      message.type === 'inputs' ? null : message
    );
    const blames: BlameReport[] = [];
    const startedAt = Date.now();

    const settled = await Promise.allSettled(
      peers.map((peer) =>
        runFusionRound(
          {
            myPubkey: peer.round.pubHex,
            participants,
            network: 'chipnet',
            tier: 100_000,
            feerate: 1_000,
            myContribution: peer.contribution,
            keysByPubkey: peer.keys,
            broadcast: async (txHex) => txidOf(txHex),
            timeoutMs: 1_000,
            jitterMs: [0, 0],
            onBlame: (report) => blames.push(report),
          },
          hub.transportFor(peer.round.pubHex)
        )
      )
    );
    const elapsed = Date.now() - startedAt;

    expect(settled.every((result) => result.status === 'rejected')).toBe(true);
    // A timeout is not a provable fault. Never blame for one.
    expect(blames).toHaveLength(0);
    // Generous, but far below timeout + the 1200ms ceiling: if the gate ever
    // stops skipping the window, this abort pays for it and trips here.
    expect(elapsed).toBeLessThan(2_000);
    expect(hub.activeHandlerCount()).toBe(0);
  });
});
