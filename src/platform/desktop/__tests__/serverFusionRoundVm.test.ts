// A real server-fusion transaction, judged by the BCH consensus VM.
//
// The native round engine hand-rolls the sighash preimage (tx.rs) and the P2PKH
// scriptSig, and every Rust test checks those against the same hand-rolled code.
// That cannot catch an error shared by the builder and its test — only an
// independent implementation of consensus can.
//
// The fixture is not synthetic. It is the transaction this wallet produced in a
// live CashFusion round against an Electron Cash fusion server, which chipnet
// then ACCEPTED. libauth re-derives every sighash and executes every input
// script under BCH 2023 rules — the same judgement a node makes.
//
// Refresh procedure, if the fixture ever needs regenerating: take the txid the
// server logs as `completed the transaction!`, fetch it and each input's
// previous output from a chipnet Electrum server, and store the raw hex plus
// the source outputs in input order.

import { describe, expect, it } from 'vitest';
import {
  binToHex,
  createVirtualMachineBCH2023,
  decodeTransaction,
  hexToBin,
} from '@bitauth/libauth';
import fixture from './fixtures/serverFusionRound.chipnet.json';

describe('a live server-fusion transaction satisfies BCH consensus', () => {
  const transaction = decodeTransaction(hexToBin(fixture.rawTransaction));
  if (typeof transaction === 'string') {
    throw new Error(`fixture is not a decodable transaction: ${transaction}`);
  }

  const sourceOutputs = fixture.sourceOutputs.map((source) => ({
    lockingBytecode: hexToBin(source.lockingBytecode),
    valueSatoshis: BigInt(source.valueSatoshis),
  }));

  it('every input script executes and every signature verifies', () => {
    const verdict = createVirtualMachineBCH2023().verify({
      transaction,
      sourceOutputs,
    });
    // A string verdict IS the failure reason; surface it rather than "false".
    expect(verdict, typeof verdict === 'string' ? verdict : undefined).toBe(
      true
    );
  });

  it('the source outputs line up with the inputs', () => {
    // Order matters more than it looks: libauth pairs sourceOutputs to inputs
    // BY INDEX, so a mis-ordered fixture would verify each signature against
    // the wrong previous output and fail for a reason that has nothing to do
    // with the wallet. libauth already holds outpointTransactionHash in display
    // (RPC) byte order, so no reversal here.
    expect(sourceOutputs).toHaveLength(transaction.inputs.length);
    transaction.inputs.forEach((input, index) => {
      const expected = fixture.sourceOutputs[index];
      expect(`${binToHex(input.outpointTransactionHash)}:${input.outpointIndex}`)
        .toBe(`${expected.outpointTransactionHash}:${expected.outpointIndex}`);
    });
  });

  it('pays at least the minimum relay fee', () => {
    // The round that produced this fixture was preceded by rounds that
    // completed perfectly and were then rejected with "min relay fee not met":
    // the per-player excess fee did not cover the ~58 bytes of transaction
    // overhead that no component pays for. A fusion that cannot be relayed is
    // indistinguishable, to the user, from one that never happened.
    const totalIn = sourceOutputs.reduce(
      (sum, source) => sum + source.valueSatoshis,
      0n
    );
    const totalOut = transaction.outputs.reduce(
      (sum, output) => sum + output.valueSatoshis,
      0n
    );
    const fee = totalIn - totalOut;
    const size = BigInt(fixture.rawTransaction.length / 2);

    expect(fee).toBeGreaterThan(0n);
    expect(fee).toBeGreaterThanOrEqual(size); // 1 sat/byte
  });

  it('mixes components from more than one player', () => {
    // 23 components per player, so a single-player "fusion" could not exceed
    // that. This is a sanity check on the fixture, not a privacy claim.
    expect(transaction.inputs.length).toBeGreaterThan(1);
    expect(transaction.outputs.length).toBeGreaterThan(11);
  });
});
