// End-to-end watch-only send tests: build an unsigned PSBT from coin control,
// sign it exactly like SeedCash would (0xc1 sighash), and verify/merge the
// result. A real secp256k1 key signs, so the verification path is exercised
// cryptographically, not just structurally.

import { describe, expect, it } from 'vitest';

import {
  binToHex,
  decodeTransaction,
  encodeCashAddress,
  generateSigningSerializationBch,
  hash160,
  hash256,
  hexToBin,
  secp256k1,
  type CompilationContextBch,
} from '@bitauth/libauth';
import { decodePsbt, encodeUnsignedPsbt } from '../psbtBch';
import { buildWatchOnlyPsbt, type WatchOnlyProposal } from '../watchOnlySend';
import { makeParentTransaction } from './parentFixture';
import {
  inspectImportedPsbt,
  mergeImportedSignatures,
} from '../watchOnlyImport';

const HARDENED = 0x80000000;
const FINGERPRINT = Uint8Array.from([0xaa, 0xbb, 0xcc, 0xdd]);
const ACCOUNT_PATH = "m/44'/145'/0'";

const privateKey = Uint8Array.from([
  0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c,
  0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18,
  0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x20,
]);
const publicKey = secp256k1.derivePublicKeyCompressed(privateKey);

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function p2pkhScript(pubKey: Uint8Array): Uint8Array {
  const hash = hash160(pubKey);
  const script = new Uint8Array(25);
  script[0] = 0x76;
  script[1] = 0xa9;
  script[2] = 0x14;
  script.set(hash, 3);
  script[23] = 0x88;
  script[24] = 0xac;
  return script;
}

function addressFor(pubKey: Uint8Array, prefix: 'bitcoincash' | 'bchtest'): string {
  return encodeCashAddress({
    payload: hash160(pubKey),
    prefix,
    type: 'p2pkh',
  }).address;
}

const recipientAddress = encodeCashAddress({
  payload: Uint8Array.from([0x99, ...new Uint8Array(19).fill(0x77)]),
  prefix: 'bchtest',
  type: 'p2pkh',
}).address;
const changeAddress = addressFor(publicKey, 'bchtest');

function makeInput(
  overrides: Partial<{
    vout: number;
    satoshis: bigint;
    branchIndex: 0 | 1;
    addressIndex: number;
    /** Varies the parent transaction, and so the txid, between fixtures. */
    seed: number;
  }> = {}
) {
  const vout = overrides.vout ?? 0;
  const satoshis = overrides.satoshis ?? 50_000n;
  const lockingBytecode = p2pkhScript(publicKey);
  const parent = makeParentTransaction({
    lockingBytecode,
    satoshis,
    vout,
    seed: overrides.seed ?? 0x11,
  });
  return {
    txid: parent.txid,
    vout,
    satoshis,
    lockingBytecodeHex: binToHex(lockingBytecode),
    publicKeyHex: binToHex(publicKey),
    branchIndex: (overrides.branchIndex ?? 1) as 0 | 1,
    addressIndex: overrides.addressIndex ?? 0,
    previousTransactionHex: parent.hex,
  };
}

function buildProposal(
  inputs: ReturnType<typeof makeInput>[],
  amountSats: bigint
): WatchOnlyProposal {
  const result = buildWatchOnlyPsbt({
    inputs,
    recipient: recipientAddress,
    amountSats,
    changeAddress,
    accountPath: ACCOUNT_PATH,
    masterFingerprint: FINGERPRINT,
  });
  return {
    rawUnsignedHex: result.rawUnsignedHex,
    inputs,
    outputs: result.outputs,
  };
}

/**
 * Sign like SeedCash: Schnorr signature + trailing sighash byte, 0xc1.
 *
 * SeedCash's `sign_tx_input` takes `use_schnorr: bool = True` and returns
 * `sign_schnorr_bch(...) + bytes([hash_type])`, so Schnorr is what actually
 * comes back off the device. DER is reachable — Paytaca templates can be built
 * with `signatureAlgorithm: 'ecdsa'` — so it stays available here as an option.
 */
function signInput(
  proposal: WatchOnlyProposal,
  inputIndex: number,
  sighashType = 0xc1,
  key = privateKey,
  algorithm: 'schnorr' | 'der' = 'schnorr'
): Uint8Array {
  const input = proposal.inputs[inputIndex];
  const noTokens = {
    category: new Uint8Array(),
    amount: 0n,
    nft: undefined,
  };
  const context: CompilationContextBch = {
    transaction: decodeTransaction(hexToBin(proposal.rawUnsignedHex)),
    inputIndex,
    sourceOutputs: proposal.inputs.map((candidate) => ({
      lockingBytecode: hexToBin(candidate.lockingBytecodeHex),
      valueSatoshis: candidate.satoshis,
      token: noTokens,
    })),
  };
  const serialization = generateSigningSerializationBch(context, {
    coveredBytecode: hexToBin(input.lockingBytecodeHex),
    signingSerializationType: Uint8Array.from([sighashType]),
  });
  const messageHash = hash256(serialization);
  const body =
    algorithm === 'schnorr'
      ? secp256k1.signMessageHashSchnorr(key, messageHash)
      : secp256k1.signMessageHashDER(key, messageHash);
  return concat([body as Uint8Array, Uint8Array.from([sighashType])]);
}

function wrapSignedPsbt(
  proposal: WatchOnlyProposal,
  sigPerInput: (Uint8Array | null)[]
): Uint8Array {
  return encodeUnsignedPsbt(
    proposal.inputs.map((input, index) => {
      const sig = sigPerInput[index];
      const base = {
        txid: input.txid,
        vout: input.vout,
        satoshis: input.satoshis,
        lockingBytecode: hexToBin(input.lockingBytecodeHex),
        publicKey: hexToBin(input.publicKeyHex),
        masterFingerprint: FINGERPRINT,
        derivationPath: [
          HARDENED | 44,
          HARDENED | 145,
          HARDENED | 0,
          input.branchIndex,
          input.addressIndex,
        ],
      };
      return sig
        ? {
            ...base,
            partialSignatures: [
              { inputIndex: index, publicKey: hexToBin(input.publicKeyHex), signature: sig },
            ],
          }
        : base;
    }),
    proposal.outputs.map((output) => ({
      lockingBytecode: hexToBin(output.lockingBytecodeHex),
      satoshis: output.satoshis,
    })),
    0xc1
  );
}

describe('buildWatchOnlyPsbt', () => {
  it('builds an unsigned PSBT with correct change and fee', () => {
    const result = buildWatchOnlyPsbt({
      inputs: [makeInput()],
      recipient: recipientAddress,
      amountSats: 30_000n,
      changeAddress,
      accountPath: ACCOUNT_PATH,
      masterFingerprint: FINGERPRINT,
    });

    expect(result.feeSats).toBeGreaterThan(0n);
    expect(result.changeSats).toBeGreaterThan(0n);
    expect(result.inputSumSats).toBe(50_000n);
    expect(result.inputSumSats - result.feeSats - 30_000n).toBe(result.changeSats);
    expect(result.outputs).toHaveLength(2);
    expect(result.outputs[1].isChange).toBe(true);

    const parsed = decodePsbt(result.psbtBytes);
    expect(binToHex(parsed.unsignedTransaction)).toBe(result.rawUnsignedHex);
    expect(parsed.version).toBe(145);
    expect(parsed.inputs).toHaveLength(1);
    expect(parsed.outputs).toHaveLength(2);
    expect(parsed.inputs[0].spentSatoshis).toBe(50_000n);
    expect(parsed.inputs[0].requestedSighashType).toBe(0xc1);
    expect(parsed.inputs[0].derivations).toHaveLength(1);
  });

  it('omits change below dust (leftover goes to fee)', () => {
    const result = buildWatchOnlyPsbt({
      inputs: [makeInput({ satoshis: 30_500n })],
      recipient: recipientAddress,
      amountSats: 30_000n,
      changeAddress,
      accountPath: ACCOUNT_PATH,
      masterFingerprint: FINGERPRINT,
    });
    expect(result.outputs).toHaveLength(1);
    expect(result.outputs[0].isChange).toBe(false);
    expect(result.changeSats).toBe(0n);
  });

  it('throws when inputs do not cover amount + fee', () => {
    expect(() =>
      buildWatchOnlyPsbt({
        inputs: [makeInput({ satoshis: 10_000n })],
        recipient: recipientAddress,
        amountSats: 30_000n,
        changeAddress,
        accountPath: ACCOUNT_PATH,
        masterFingerprint: FINGERPRINT,
      })
    ).toThrow(/needed|cover/);
  });

  it('builds without a master fingerprint instead of refusing', () => {
    // This used to throw. It should not: the fingerprint is not derivable from
    // an account xPub, and SeedCash does not use it to sign — only to decide
    // whether its review screen claims the inputs. Refusing here blocked a
    // send that works. See the flagged case in the import-verification block.
    expect(() =>
      buildWatchOnlyPsbt({
        inputs: [makeInput()],
        recipient: recipientAddress,
        amountSats: 30_000n,
        changeAddress,
        accountPath: ACCOUNT_PATH,
        masterFingerprint: null,
      })
    ).not.toThrow();
  });

  it('rejects incomplete multisig change metadata instead of falling back to P2PKH change', () => {
    expect(() =>
      buildWatchOnlyPsbt({
        inputs: [makeInput()],
        recipient: recipientAddress,
        amountSats: 30_000n,
        changeAddress,
        accountPath: ACCOUNT_PATH,
        masterFingerprint: FINGERPRINT,
        changeRedeemScriptHex: '51',
      })
    ).toThrow(/both the redeem script and cosigner derivations/i);
  });

  it('writes per-input BIP32 derivation with the wallet fingerprint', () => {
    const result = buildWatchOnlyPsbt({
      inputs: [makeInput({ branchIndex: 1, addressIndex: 3 })],
      recipient: recipientAddress,
      amountSats: 30_000n,
      changeAddress,
      accountPath: ACCOUNT_PATH,
      masterFingerprint: FINGERPRINT,
    });
    const parsed = decodePsbt(result.psbtBytes);
    const derivation = parsed.inputs[0].derivations[0];
    expect(derivation).toBeDefined();
    expect(derivation.publicKey).toEqual(publicKey);
    expect(derivation.masterFingerprint).toEqual(FINGERPRINT);
    expect(derivation.derivationPath).toEqual([
      HARDENED + 44,
      HARDENED + 145,
      HARDENED + 0,
      1,
      3,
    ]);
  });
});

describe('watch-only import verification', () => {
  it('accepts a fully signed PSBT and merges it into a broadcastable tx', () => {
    const proposal = buildProposal([makeInput()], 30_000n);
    const signed = wrapSignedPsbt(proposal, [signInput(proposal, 0)]);

    const result = inspectImportedPsbt(signed, proposal);
    expect(result.state).toBe('complete');
    expect(result.signedInputCount).toBe(1);

    const rawTxHex = mergeImportedSignatures(signed, proposal);
    expect(rawTxHex).not.toBe(proposal.rawUnsignedHex);
    expect(rawTxHex.length / 2).toBeGreaterThan(
      proposal.rawUnsignedHex.length / 2
    );
  });

  it('rejects a PSBT that was built from a different transaction', () => {
    const proposal = buildProposal([makeInput()], 30_000n);
    const otherProposal = buildProposal([makeInput()], 25_000n);
    const signed = wrapSignedPsbt(otherProposal, [signInput(otherProposal, 0)]);

    const result = inspectImportedPsbt(signed, proposal);
    expect(result.state).toBe('rejected');
  });

  it('flags an unsigned return', () => {
    const proposal = buildProposal([makeInput()], 30_000n);
    const unsigned = wrapSignedPsbt(proposal, [null]);
    expect(inspectImportedPsbt(unsigned, proposal).state).toBe('unsigned');
  });

  it('flags a partially-signed multi-input PSBT', () => {
    const secondInput = makeInput({ seed: 0x22, vout: 1 });
    const proposal = buildProposal([makeInput(), secondInput], 60_000n);
    const signed = wrapSignedPsbt(proposal, [signInput(proposal, 0), null]);
    const result = inspectImportedPsbt(signed, proposal);
    expect(result.state).toBe('partially-signed');
    expect(result.signedInputCount).toBe(1);
    expect(result.totalInputCount).toBe(2);
  });

  it('builds a signable PSBT with no master fingerprint, and flags it', () => {
    // Measured against the real SeedCash signer, not inferred: it reads only
    // the path out of the 0x06 record and discards the fingerprint, so a PSBT
    // stamped with a wrong (or zero) fingerprint still produced a signature
    // that verifies and that libauth's BCH VM executes. Blocking the send on a
    // missing fingerprint was therefore refusing a transaction that works.
    //
    // What it costs is the device's review screen: SeedCash claims an input
    // via `v[:4] == wallet_fingerprint`, so the user is approving something the
    // device cannot confirm is theirs. Hence a flag rather than silence.
    const input = makeInput();
    const built = buildWatchOnlyPsbt({
      inputs: [input],
      recipient: recipientAddress,
      amountSats: 30_000n,
      changeAddress,
      accountPath: ACCOUNT_PATH,
      masterFingerprint: null,
    });

    expect(built.signerRecognisesInputs).toBe(false);
    expect(built.masterFingerprint).toBeNull();

    // The derivation record must still be present, or SeedCash refuses to sign
    // with "xpriv signing requires a PSBT derivation path".
    const parsed = decodePsbt(built.psbtBytes);
    expect(parsed.inputs[0].derivations).toHaveLength(1);
    expect(parsed.inputs[0].derivations[0].derivationPath).toEqual([
      HARDENED + 44,
      HARDENED + 145,
      HARDENED + 0,
      input.branchIndex,
      input.addressIndex,
    ]);

    // And it round-trips: a signature over this PSBT still verifies.
    const proposal: WatchOnlyProposal = {
      rawUnsignedHex: built.rawUnsignedHex,
      inputs: [input],
      outputs: built.outputs,
    };
    const signed = wrapSignedPsbt(proposal, [signInput(proposal, 0)]);
    expect(inspectImportedPsbt(signed, proposal).state).toBe('complete');
  });

  it('reports the signer will recognise inputs when a fingerprint is set', () => {
    const built = buildWatchOnlyPsbt({
      inputs: [makeInput()],
      recipient: recipientAddress,
      amountSats: 30_000n,
      changeAddress,
      accountPath: ACCOUNT_PATH,
      masterFingerprint: FINGERPRINT,
    });
    expect(built.signerRecognisesInputs).toBe(true);
  });

  it('accepts a DER signature as well as a Schnorr one', () => {
    // Every other test here signs Schnorr, because that is what SeedCash
    // actually returns. DER must keep working too: Paytaca templates can be
    // built with `signatureAlgorithm: 'ecdsa'`, and BCH tells the two apart by
    // length alone — 64 bytes is Schnorr, anything else is parsed as DER.
    const proposal = buildProposal([makeInput()], 30_000n);
    const der = signInput(proposal, 0, 0xc1, privateKey, 'der');
    expect(der.length - 1).not.toBe(64);

    const signed = wrapSignedPsbt(proposal, [der]);
    expect(inspectImportedPsbt(signed, proposal).state).toBe('complete');
  });

  it('rejects a signature with the wrong sighash type', () => {
    const proposal = buildProposal([makeInput()], 30_000n);
    const signed = wrapSignedPsbt(proposal, [signInput(proposal, 0, 0x41)]);
    expect(inspectImportedPsbt(signed, proposal).state).toBe('invalid');
  });

  it('rejects a signature made with a different key', () => {
    const proposal = buildProposal([makeInput()], 30_000n);
    const otherKey = Uint8Array.from([0xff, ...new Uint8Array(31).fill(0xee)]);
    const signed = wrapSignedPsbt(proposal, [signInput(proposal, 0, 0xc1, otherKey)]);
    expect(inspectImportedPsbt(signed, proposal).state).toBe('invalid');
  });
});
