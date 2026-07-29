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
import { runFusionRound, type RoundMessage, type RoundTransport, type RoundParams } from '../fusionSession';
import { assembleFusionTx, type PeerContribution } from '../fusionRound';
import { toLibauthTx } from '../fusionSign';

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
  transportFor(me: string): RoundTransport {
    return {
      send: async (to, msg) => {
        const hs = this.handlers.get(to);
        if (hs && hs.length) {
          for (const h of hs) queueMicrotask(() => h(me, msg));
        } else {
          const box = this.mailbox.get(to) ?? [];
          box.push([me, msg]);
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
      return { round, keys: new Map([[inKey.pubHex, inKey.priv]]), contribution };
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
          myContribution: p.contribution,
          keysByPubkey: p.keys,
          broadcast,
          timeoutMs: 5000,
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
      return { round, keys: new Map([[inKey.pubHex, inKey.priv]]), contribution };
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
            timeoutMs: 250,
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
    const coordinator = '0'.repeat(64);
    const participant = 'f'.repeat(64);
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
    let handler: Handler = () => undefined;
    const transport: RoundTransport = {
      send: async (_to, message) => {
        if (message.type === 'outputs') {
          queueMicrotask(() =>
            handler(coordinator, {
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
          myContribution: contribution,
          keysByPubkey: new Map([[input.pubHex, input.priv]]),
          broadcast: async () => {
            throw new Error('participant must not broadcast');
          },
          timeoutMs: 1_000,
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
          myContribution: contribution,
          keysByPubkey: new Map([[input.pubHex, input.priv]]),
          broadcast: async () => '',
          timeoutMs: 50,
        },
        transport
      )
    ).rejects.toThrow('Invalid Fusion round message');
  });
});
