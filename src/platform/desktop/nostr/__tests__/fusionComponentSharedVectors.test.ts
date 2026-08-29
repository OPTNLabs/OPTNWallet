// The TypeScript half of the shared component-format vectors.
//
// `test-vectors/fusion-components.json` is read by BOTH encoders of the
// CashFusion component wire format: this side, which hand-writes protobuf, and
// src-tauri/src/fusion/p2p_component.rs, which uses prost.
//
// The two already agreed on one Electron Cash golden value — the same literal
// was duplicated into both files. One input component, one amount, one index.
// Nothing covered the varint boundaries, and a hand-rolled writer against prost
// is exactly where those drift: 127 and 128 differ in width, and an off-by-one
// there yields a component the other side hashes differently. The credential
// then gets blind-signed over bytes the round does not recognise, which surfaces
// as a peer rejecting us rather than as anything that looks like an encoder bug.
//
// If a vector fails, one of the two encoders is wrong. Fix the code.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { binToHex, hexToBin } from '@bitauth/libauth';
import {
  componentBlindMessageHash,
  encodeInputComponent,
  encodeOutputComponent,
  saltCommitmentFromSalt,
  saltedComponentHashHex,
} from '../fusionComponentV4';

type InputVector = {
  prevTxidDisplayHex: string;
  prevTxidWireHex: string;
  prevIndex: number;
  pubkeyHex: string;
  amount: number;
  saltCommitmentHex: string;
  serializedHex: string;
  blindMessageHex: string;
};

type OutputVector = {
  scriptHex: string;
  amount: number;
  saltCommitmentHex: string;
  serializedHex: string;
  blindMessageHex: string;
};

type SaltVector = {
  saltHex: string;
  saltCommitmentHex: string;
  componentHex: string;
  saltedComponentHashHex: string;
};

type ComponentVectors = {
  electronCashGolden: {
    prevTxidWireHex: string;
    prevIndex: number;
    pubkeyHex: string;
    amount: number;
    saltCommitmentHex: string;
    serializedHex: string;
  };
  inputComponents: InputVector[];
  outputComponents: OutputVector[];
  salts: SaltVector[];
};

const vectors: ComponentVectors = JSON.parse(
  readFileSync('test-vectors/fusion-components.json', 'utf8')
);

function reverseHex(hex: string): string {
  const bytes = hexToBin(hex);
  return binToHex(bytes.reverse());
}

describe('shared CashFusion component vectors', () => {
  it('has vectors to check', () => {
    expect(vectors.inputComponents.length).toBeGreaterThan(0);
    expect(vectors.outputComponents.length).toBeGreaterThan(0);
    expect(vectors.salts.length).toBeGreaterThan(0);
  });

  it('encodes input components exactly as prost does', () => {
    for (const vector of vectors.inputComponents) {
      const encoded = encodeInputComponent({
        prevTxidDisplayHex: vector.prevTxidDisplayHex,
        prevIndex: vector.prevIndex,
        pubkeyHex: vector.pubkeyHex,
        amount: vector.amount,
        saltCommitmentHex: vector.saltCommitmentHex,
      });
      expect(
        binToHex(encoded),
        `input component amount=${vector.amount} index=${vector.prevIndex}`
      ).toBe(vector.serializedHex);
      expect(binToHex(componentBlindMessageHash(encoded))).toBe(
        vector.blindMessageHex
      );
    }
  });

  it('encodes output components exactly as prost does', () => {
    for (const vector of vectors.outputComponents) {
      const encoded = encodeOutputComponent({
        scriptHex: vector.scriptHex,
        amount: vector.amount,
        saltCommitmentHex: vector.saltCommitmentHex,
      });
      expect(
        binToHex(encoded),
        `output component amount=${vector.amount} script=${vector.scriptHex.length / 2}B`
      ).toBe(vector.serializedHex);
      expect(binToHex(componentBlindMessageHash(encoded))).toBe(
        vector.blindMessageHex
      );
    }
  });

  it('reproduces the Electron Cash golden vector from its inputs', () => {
    // The anchor that is not merely the two of us agreeing with each other.
    const golden = vectors.electronCashGolden;
    const encoded = encodeInputComponent({
      prevTxidDisplayHex: reverseHex(golden.prevTxidWireHex),
      prevIndex: golden.prevIndex,
      pubkeyHex: golden.pubkeyHex,
      amount: golden.amount,
      saltCommitmentHex: golden.saltCommitmentHex,
    });
    expect(binToHex(encoded)).toBe(golden.serializedHex);
  });

  it('takes the txid in display order and writes it in wire order', () => {
    // The one field where the two encoders differ in what they accept. Passing
    // wire order where display is expected produces a component that encodes
    // cleanly and is simply wrong, so this asserts the direction rather than
    // trusting it.
    const vector = vectors.inputComponents[0];
    expect(vector.prevTxidDisplayHex).toBe(
      reverseHex(vector.prevTxidWireHex)
    );
    const wrongWayRound = encodeInputComponent({
      prevTxidDisplayHex: vector.prevTxidWireHex,
      prevIndex: vector.prevIndex,
      pubkeyHex: vector.pubkeyHex,
      amount: vector.amount,
      saltCommitmentHex: vector.saltCommitmentHex,
    });
    // Only meaningful because the fixture txid is not a palindrome.
    expect(binToHex(wrongWayRound)).not.toBe(vector.serializedHex);
  });

  it('derives salt commitments and salted component hashes the same way', () => {
    for (const vector of vectors.salts) {
      expect(binToHex(saltCommitmentFromSalt(hexToBin(vector.saltHex)))).toBe(
        vector.saltCommitmentHex
      );
      expect(
        saltedComponentHashHex(vector.saltHex, hexToBin(vector.componentHex))
      ).toBe(vector.saltedComponentHashHex);
    }
  });

  it('covers the varint width boundaries', () => {
    // Guards the fixtures from being narrowed later: if every amount fell under
    // 128 this file would prove much less than it appears to.
    const amounts = vectors.inputComponents.map((vector) => vector.amount);
    expect(amounts.some((amount) => amount < 128)).toBe(true);
    expect(amounts.some((amount) => amount >= 128 && amount < 16_384)).toBe(
      true
    );
    expect(amounts.some((amount) => amount >= 2_097_152)).toBe(true);
  });
});
