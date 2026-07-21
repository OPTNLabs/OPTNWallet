import { describe, expect, it } from 'vitest';
import { SimplePool, generateSecretKey, getPublicKey, type Event } from 'nostr-tools';
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
import { createNostrRoundTransport, GIFT_WRAP_KIND } from '../fusionTransport';
import { runFusionRound, type RoundParams } from '../fusionSession';
import { assembleFusionTx, type PeerContribution } from '../fusionRound';
import { toLibauthTx } from '../fusionSign';

/** Minimal relay stand-in: stores events and delivers to subscriptions whose
 *  {kinds, #p} filter matches — including subscriptions opened later. */
class FakePool {
  private events: Event[] = [];
  private subs: Array<{ filter: Record<string, unknown>; onevent: (e: Event) => void }> = [];
  private matches(filter: Record<string, unknown>, e: Event): boolean {
    const kinds = filter.kinds as number[] | undefined;
    if (kinds && !kinds.includes(e.kind)) return false;
    const pTags = filter['#p'] as string[] | undefined;
    if (pTags && !e.tags.some((t) => t[0] === 'p' && pTags.includes(t[1]))) return false;
    return true;
  }
  publish(_relays: string[], event: Event): Promise<string>[] {
    this.events.push(event);
    for (const s of this.subs) if (this.matches(s.filter, event)) queueMicrotask(() => s.onevent(event));
    return [Promise.resolve('ok')];
  }
  subscribeMany(_relays: string[], filter: Record<string, unknown>, cbs: { onevent: (e: Event) => void }) {
    const sub = { filter, onevent: cbs.onevent };
    this.subs.push(sub);
    for (const e of this.events) if (this.matches(filter, e)) queueMicrotask(() => cbs.onevent(e));
    return { close: () => { this.subs = this.subs.filter((s) => s !== sub); } };
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
const p2pkhHex = (h: string) => binToHex(encodeLockingBytecodeP2pkh(hash160(hexToBin(h))));
function roundId() {
  const sk = generateSecretKey();
  return { secretKey: sk, pubkey: getPublicKey(sk) };
}

describe('Nostr round transport', () => {
  it('gift-wraps a message (kind 1059) to the peer and round-trips', async () => {
    const relays = ['wss://fake'];
    const pool = new FakePool();
    const a = roundId();
    const b = roundId();
    const ta = createNostrRoundTransport(asPool(pool), relays, a);
    const tb = createNostrRoundTransport(asPool(pool), relays, b);

    const got: Array<{ from: string; type: string }> = [];
    tb.onMessage((from, msg) => got.push({ from, type: msg.type }));
    await ta.send(b.pubkey, { type: 'inputs', session: 's', inputs: [] });
    await new Promise((r) => setTimeout(r, 10));

    expect(got).toHaveLength(1);
    expect(got[0].from).toBe(a.pubkey); // inputs are attributable to the round identity
    expect(got[0].type).toBe('inputs');
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
    tb.onMessage((from, msg) => { if (msg.type === 'outputs') fromPubkey = from; });
    await ta.send(b.pubkey, { type: 'outputs', session: 's', outputs: [{ script: '00', value: 1 }] });
    await new Promise((r) => setTimeout(r, 10));

    expect(fromPubkey).not.toBe('');
    expect(fromPubkey).not.toBe(a.pubkey); // NOT the round key → can't be linked to its inputs
  });

  it('drives a full 2-peer round to a VM-valid CoinJoin over the transport', async () => {
    const pool = new FakePool();
    const relays = ['wss://fake'];

    const peers = [1, 2].map((n) => {
      const inKey = kp(n * 10 + 1);
      const outKey = kp(n * 10 + 2);
      const round = roundId();
      const contribution: PeerContribution = {
        inputs: [{ prevTxid: `${n}${'c'.repeat(63)}`, prevIndex: n, value: 100_000, pubkey: inKey.pubHex }],
        outputs: [{ script: p2pkhHex(outKey.pubHex), value: 99_700 }],
      };
      return { round, keys: new Map([[inKey.pubHex, inKey.priv]]), contribution };
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
          timeoutMs: 5000,
        };
        return runFusionRound(params, createNostrRoundTransport(asPool(pool), relays, p.round));
      })
    );

    expect(new Set(results.map((r) => r.txid)).size).toBe(1);
    expect(broadcasts).toBe(1);

    const decoded = decodeTransaction(hexToBin(results[0].txHex)) as TransactionCommon;
    const { sourceOutputs } = toLibauthTx(assembleFusionTx(peers.map((p) => p.contribution)));
    expect(createVirtualMachineBCH2023().verify({ transaction: decoded, sourceOutputs })).toBe(true);
    expect(decoded.inputs).toHaveLength(2);
    expect(decoded.outputs).toHaveLength(2);
  });
});
