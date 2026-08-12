import { describe, expect, it } from 'vitest';
import {
  assembleFusionTx,
  verifyFusionSafety,
  minimumFee,
  MAX_FEE_FACTOR,
  type PeerContribution,
} from '../fusionRound';

const pk = '02' + 'ab'.repeat(32); // 33-byte compressed pubkey (hex)
const script = (n: number) => '76a914' + n.toString(16).padStart(40, '0') + '88ac'; // p2pkh-ish, unique

// Three peers each fusing one 100k input into one 100k tier output.
function threePeers(): PeerContribution[] {
  return [0, 1, 2].map((n) => ({
    inputs: [{ prevTxid: `${n}${'0'.repeat(63)}`, prevIndex: n, value: 100_000, pubkey: pk }],
    outputs: [{ script: script(n + 1), value: 99_500 }], // 500 sat fee each
  }));
}

describe('assembleFusionTx', () => {
  it('produces the identical tx regardless of contribution order (coordinator can\'t cheat ordering)', () => {
    const peers = threePeers();
    const a = assembleFusionTx(peers);
    const b = assembleFusionTx([peers[2], peers[0], peers[1]]);
    expect(a).toEqual(b);
    // BIP69: inputs sorted by outpoint, outputs by value then script.
    expect(a.inputs.map((i) => i.prevIndex)).toEqual([0, 1, 2]);
    expect(a.inputs).toHaveLength(3);
    expect(a.outputs).toHaveLength(3);
  });

  it('rejects a duplicate outpoint (a peer registering someone else\'s coin)', () => {
    const peers = threePeers();
    peers[1].inputs[0] = { ...peers[0].inputs[0] };
    expect(() => assembleFusionTx(peers)).toThrow(/duplicate input/);
  });
});

describe('verifyFusionSafety', () => {
  const feerate = 1000; // 1 sat/byte

  it('accepts a well-formed round for a participant', () => {
    const peers = threePeers();
    const tx = assembleFusionTx(peers);
    const r = verifyFusionSafety(tx, peers[0], feerate);
    expect(r.ok).toBe(true);
    expect(r.fee).toBe(1500); // 3 * 500
    expect(r.fee).toBeGreaterThanOrEqual(r.requiredFee);
  });

  it('REFUSES when my output was dropped', () => {
    const peers = threePeers();
    const tx = assembleFusionTx(peers);
    tx.outputs = tx.outputs.filter((o) => o.script !== script(1)); // drop peer 0's output
    const r = verifyFusionSafety(tx, peers[0], feerate);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/missing/);
  });

  it('REFUSES when my output value was shrunk', () => {
    const peers = threePeers();
    // The peer keeps its OWN registration object (independent of the tx it's sent).
    const mine: PeerContribution = { inputs: peers[0].inputs, outputs: [{ script: script(1), value: 99_500 }] };
    const tx = assembleFusionTx(peers);
    // Replace (not mutate) my output with a shrunk copy — as a hostile coordinator would.
    tx.outputs = tx.outputs.map((o) => (o.script === script(1) ? { ...o, value: 50_000 } : o));
    const r = verifyFusionSafety(tx, mine, feerate);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/missing/); // (value,script) no longer matches
  });

  it('REFUSES when one of my inputs is absent (I would fund a tx that isn\'t mine)', () => {
    const peers = threePeers();
    const tx = assembleFusionTx(peers);
    const mine: PeerContribution = {
      inputs: [{ prevTxid: 'f'.repeat(64), prevIndex: 7, value: 100_000, pubkey: pk }],
      outputs: peers[0].outputs,
    };
    const r = verifyFusionSafety(tx, mine, feerate);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/input .* missing/);
  });

  it('REFUSES an inflating transaction (outputs exceed inputs)', () => {
    const peers = threePeers();
    peers.forEach((p) => (p.outputs[0].value = 200_000)); // out > in
    const tx = assembleFusionTx(peers);
    const r = verifyFusionSafety(tx, peers[0], feerate);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/inflation/);
  });

  it('REFUSES an underpaying transaction (would never confirm)', () => {
    const peers = threePeers();
    peers.forEach((p) => (p.outputs[0].value = 99_999)); // fee 1 sat each, well under min
    const tx = assembleFusionTx(peers);
    const r = verifyFusionSafety(tx, peers[0], feerate);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/underpays/);
    expect(r.requiredFee).toBeGreaterThan(r.fee);
  });

  it('REFUSES an absurd fee (coordinator burning peers\' money to miners)', () => {
    const peers = threePeers();
    const tx = assembleFusionTx(peers);
    const required = minimumFee(tx, feerate);
    // Shrink every output equally so the fee blows past MAX_FEE_FACTOR * required.
    const skim = Math.ceil((required * MAX_FEE_FACTOR) / 3) + 1000;
    tx.outputs.forEach((o) => (o.value -= skim));
    // Peer 0 checks against its (now-shrunk) real output so it fails on fee, not "missing".
    const mine: PeerContribution = {
      inputs: peers[0].inputs,
      outputs: [{ script: script(1), value: 99_500 - skim }],
    };
    const r = verifyFusionSafety(tx, mine, feerate);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/too high/);
  });
});
