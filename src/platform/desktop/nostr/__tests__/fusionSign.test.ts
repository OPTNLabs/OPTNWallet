import { describe, expect, it } from 'vitest';
import {
  secp256k1,
  createVirtualMachineBCH2023,
  encodeLockingBytecodeP2pkh,
  binToHex,
  hexToBin,
} from '@bitauth/libauth';
import { hash160 } from '@cashscript/utils';
import { signMyInputs, finalizeFusionTx } from '../fusionSign';
import { assembleFusionTx, verifyFusionSafety, type PeerContribution } from '../fusionRound';

function keypair(seed: number): { priv: Uint8Array; pubHex: string } {
  const priv = new Uint8Array(32);
  priv[31] = seed; // small but valid secp256k1 scalar
  const pub = secp256k1.derivePublicKeyCompressed(priv);
  if (typeof pub === 'string') throw new Error(pub);
  return { priv, pubHex: binToHex(pub) };
}

const p2pkhHex = (pubHex: string) => binToHex(encodeLockingBytecodeP2pkh(hash160(hexToBin(pubHex))));

describe('P2P fusion signing produces a network-valid CoinJoin', () => {
  it('signs own inputs and the assembled tx passes libauth\'s consensus VM', () => {
    // Two coins I control, fusing into two fresh 99k outputs (2k total fee).
    const a = keypair(11);
    const b = keypair(22);
    const outA = keypair(33);
    const outB = keypair(44);

    const contributions: PeerContribution[] = [
      {
        inputs: [
          { prevTxid: 'aa'.repeat(32), prevIndex: 0, value: 100_000, pubkey: a.pubHex },
          { prevTxid: 'bb'.repeat(32), prevIndex: 1, value: 100_000, pubkey: b.pubHex },
        ],
        outputs: [
          { script: p2pkhHex(outA.pubHex), value: 99_800 },
          { script: p2pkhHex(outB.pubHex), value: 99_800 }, // fee 400 > min ~360, within cap
        ],
      },
    ];

    const tx = assembleFusionTx(contributions);
    expect(verifyFusionSafety(tx, contributions[0], 1000).ok).toBe(true);

    const keys = new Map([
      [a.pubHex, a.priv],
      [b.pubHex, b.priv],
    ]);
    const sigs = signMyInputs(tx, keys);
    expect(sigs).toHaveLength(2);

    const { transaction, sourceOutputs, txid } = finalizeFusionTx(tx, sigs);
    expect(txid).toMatch(/^[0-9a-f]{64}$/);

    // Gold standard: the BCH VM re-derives every sighash and runs each script.
    const vm = createVirtualMachineBCH2023();
    const result = vm.verify({ transaction, sourceOutputs });
    expect(result).toBe(true);
  });

  it('only signs inputs whose key we hold (never touches others\' coins)', () => {
    const mine = keypair(7);
    const theirs = keypair(8);
    const out = keypair(9);
    const tx = assembleFusionTx([
      {
        inputs: [
          { prevTxid: '11'.repeat(32), prevIndex: 0, value: 60_000, pubkey: mine.pubHex },
          { prevTxid: '22'.repeat(32), prevIndex: 0, value: 60_000, pubkey: theirs.pubHex },
        ],
        outputs: [{ script: p2pkhHex(out.pubHex), value: 119_000 }],
      },
    ]);
    const sigs = signMyInputs(tx, new Map([[mine.pubHex, mine.priv]]));
    expect(sigs).toHaveLength(1);
    expect(sigs[0].prevTxid).toBe('11'.repeat(32));
    // Finalizing without every signature must fail closed, not broadcast a half-signed tx.
    expect(() => finalizeFusionTx(tx, sigs)).toThrow(/missing signature/);
  });
});
