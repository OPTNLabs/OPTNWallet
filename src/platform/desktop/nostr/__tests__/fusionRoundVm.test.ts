// A whole fusion round, run in memory, judged by the BCH consensus VM.
//
// A live round needs a pool, funded wallets, a server and luck with timing, so
// it is the slowest possible way to learn that the transaction we build is
// malformed. This runs the same assembly and signing path with N independent
// participants — each holding ONLY its own keys, exactly as in a real round —
// and then hands the result to libauth's virtual machine, which re-derives
// every sighash and executes every input script under BCH 2023 rules.
//
// That is the same judgement a node makes at broadcast. It cannot tell us the
// pool logic works, but it can tell us that when a pool does form, the thing we
// hand the network is valid — which is the failure that costs a round and,
// historically here, a day of debugging ("Missing inputs" after everyone had
// already signed).

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
import {
  assembleFusionTx,
  verifyFusionSafety,
  type PeerContribution,
} from '../fusionRound';

function keypair(seed: number): { priv: Uint8Array; pubHex: string } {
  const priv = new Uint8Array(32);
  // Two bytes so seeds above 255 stay distinct and remain valid scalars.
  priv[30] = (seed >> 8) & 0xff;
  priv[31] = seed & 0xff;
  const pub = secp256k1.derivePublicKeyCompressed(priv);
  if (typeof pub === 'string') throw new Error(pub);
  return { priv, pubHex: binToHex(pub) };
}

const p2pkhHex = (pubHex: string) =>
  binToHex(encodeLockingBytecodeP2pkh(hash160(hexToBin(pubHex))));

interface Participant {
  /** Only this participant's own keys — nobody can sign for anyone else. */
  keys: Map<string, Uint8Array>;
  contribution: PeerContribution;
}

/**
 * One participant: `inputsEach` coins in, the same number of equal-value
 * outputs out, each to a fresh key.
 */
function makeParticipant(
  index: number,
  inputsEach: number,
  inputValue: number,
  outputValue: number
): Participant {
  const keys = new Map<string, Uint8Array>();
  const inputs: PeerContribution['inputs'] = [];
  const outputs: PeerContribution['outputs'] = [];

  for (let i = 0; i < inputsEach; i += 1) {
    const coin = keypair(1000 + index * 50 + i);
    keys.set(coin.pubHex, coin.priv);
    inputs.push({
      // Distinct per participant AND per coin, so no two inputs collide.
      prevTxid: `${(index + 1).toString(16).padStart(2, '0')}${(i + 1)
        .toString(16)
        .padStart(2, '0')}`.padEnd(64, 'c'),
      prevIndex: i,
      value: inputValue,
      pubkey: coin.pubHex,
    });

    const fresh = keypair(5000 + index * 50 + i);
    outputs.push({ script: p2pkhHex(fresh.pubHex), value: outputValue });
  }

  return { keys, contribution: { inputs, outputs } };
}

/** Run a full round and return what the network would be handed. */
function runRound(participants: Participant[]) {
  const contributions = participants.map((p) => p.contribution);

  // Every participant assembles the transaction independently from the same
  // contributions. If assembly were order-dependent they would sign different
  // transactions and every signature would be invalid — so this also checks
  // that assembly is canonical.
  const assembled = participants.map(() => assembleFusionTx(contributions));
  const canonical = assembled[0];
  for (const tx of assembled.slice(1)) {
    expect(binToHex(hexToBin(JSON.stringify(tx) === JSON.stringify(canonical) ? '01' : '00'))).toBe('01');
  }

  // Each participant checks its own outputs survived before signing.
  for (const participant of participants) {
    const safety = verifyFusionSafety(canonical, participant.contribution, 1000);
    expect(safety.ok, `safety: ${JSON.stringify(safety)}`).toBe(true);
  }

  // Each signs ONLY its own inputs, with only its own keys.
  const signatures = participants.flatMap((participant) =>
    signMyInputs(canonical, participant.keys)
  );

  return { canonical, signatures };
}

describe('a full fusion round is accepted by the BCH consensus VM', () => {
  for (const players of [2, 3, 5, 8]) {
    it(`${players} participants, each signing only their own coins`, () => {
      const inputsEach = 2;
      const participants = Array.from({ length: players }, (_, i) =>
        makeParticipant(i, inputsEach, 100_000, 99_700)
      );

      const { canonical, signatures } = runRound(participants);
      expect(signatures).toHaveLength(players * inputsEach);

      const { transaction, sourceOutputs, txid } = finalizeFusionTx(
        canonical,
        signatures
      );
      expect(txid).toMatch(/^[0-9a-f]{64}$/);

      // The gold standard: re-derives every sighash, runs every input script.
      const vm = createVirtualMachineBCH2023();
      const verdict = vm.verify({ transaction, sourceOutputs });
      expect(verdict, typeof verdict === 'string' ? verdict : undefined).toBe(
        true
      );

      // A CoinJoin is only a CoinJoin if the outputs are indistinguishable.
      const values = new Set(transaction.outputs.map((o) => o.valueSatoshis));
      expect(values.size).toBe(1);
      expect(transaction.inputs).toHaveLength(players * inputsEach);
    });
  }

  it('rejects the transaction if one signature is missing', () => {
    // A round that broadcasts half-signed is the expensive failure: everyone
    // has already revealed their coins by then.
    const participants = Array.from({ length: 3 }, (_, i) =>
      makeParticipant(i, 1, 100_000, 99_700)
    );
    const { canonical, signatures } = runRound(participants);

    // Stronger than "the VM rejects it": finalization REFUSES to build a
    // transaction it cannot fully sign, so a half-signed round can never reach
    // a broadcast attempt in the first place.
    expect(() =>
      finalizeFusionTx(canonical, signatures.slice(0, signatures.length - 1))
    ).toThrow(/missing signature/i);
  });

  it("rejects a transaction carrying another participant's signature on my input", () => {
    // Proves the signatures are bound to their input, not merely present in the
    // right quantity.
    const participants = Array.from({ length: 2 }, (_, i) =>
      makeParticipant(i, 1, 100_000, 99_700)
    );
    const { canonical } = runRound(participants);

    // Participant 0 signs, then that signature is used for BOTH inputs.
    const mine = signMyInputs(canonical, participants[0].keys);
    const forged = [mine[0], { ...mine[0], inputIndex: 1 }];

    // Reusing one participant's signature for a second input does not even get
    // as far as the VM: the signature is bound to its input index, so the other
    // input is simply unsigned and finalization refuses.
    expect(() => finalizeFusionTx(canonical, forged)).toThrow(
      /missing signature/i
    );
  });
});
