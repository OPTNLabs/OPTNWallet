// 2-of-3 multisig round trip for the watch-only PSBT flow, byte-for-byte
// matched to Paytaca's multisig policy:
//
//   * redeem script  OP_2 <BIP-67-sorted keys> OP_3 OP_CHECKMULTISIG
//   * P2SH20 locking script
//   * unlock script OP_0 <sigA> <sigB> <redeemScript>
//   * merge binds candidates to the same unsigned transaction and
//     cryptographically verifies every partial signature
//
// Real secp256k1 keys sign, so merge verification is cryptographic, not
// structural.

import { describe, expect, it } from 'vitest';

import {
  binToHex,
  createVirtualMachineBCH,
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
import { buildWatchOnlyPsbt } from '../watchOnlySend';
import { makeParentTransaction } from './parentFixture';
import {
  inspectImportedPsbt,
  mergeImportedSignatures,
} from '../watchOnlyImport';
import {
  buildMultisigRedeemScript,
  cosignerStatuses,
  isMultisigRedeemScript,
  mergePsbts,
  p2shLockingBytecodeFor,
  parseMultisigRedeemScript,
  pushData,
  pushMinimal,
  schnorrCheckBits,
  sortPublicKeysBip67,
  type CosignerStatus,
} from '../psbtMultisig';

const HARDENED = 0x80000000;
const ACCOUNT_PATH = "m/44'/145'/0'";

const privateKeys = [
  Uint8Array.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x20]),
  Uint8Array.from([0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x2b, 0x2c, 0x2d, 0x2e, 0x2f, 0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x3b, 0x3c, 0x3d, 0x3e, 0x3f, 0x40]),
  Uint8Array.from([0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x4b, 0x4c, 0x4d, 0x4e, 0x4f, 0x50, 0x51, 0x52, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x5b, 0x5c, 0x5d, 0x5e, 0x5f, 0x60]),
];
const publicKeys = privateKeys.map((key) => secp256k1.derivePublicKeyCompressed(key));
const fingerprints = [
  Uint8Array.from([0xaa, 0xbb, 0xcc, 0x01]),
  Uint8Array.from([0xaa, 0xbb, 0xcc, 0x02]),
  Uint8Array.from([0xaa, 0xbb, 0xcc, 0x03]),
];
const keyPaths = [
  `${ACCOUNT_PATH}/0/0`,
  `${ACCOUNT_PATH}/0/1`,
  `${ACCOUNT_PATH}/0/2`,
];

/** Deliberately scrambled: BIP-67 must reorder them in the script. */
const scrambledKeys = [publicKeys[2], publicKeys[0], publicKeys[1]];
const redeemScript = buildMultisigRedeemScript(scrambledKeys, 2);
const p2shLocking = p2shLockingBytecodeFor(redeemScript);

const recipientAddress = encodeCashAddress({
  payload: Uint8Array.from([0x99, ...new Uint8Array(19).fill(0x77)]),
  prefix: 'bchtest',
  type: 'p2pkh',
}).address;
const changeAddress = encodeCashAddress({
  payload: Uint8Array.from([0x88, ...new Uint8Array(19).fill(0x66)]),
  prefix: 'bchtest',
  type: 'p2pkh',
}).address;

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

const MULTISIG_PARENT = makeParentTransaction({
  lockingBytecode: p2shLocking,
  satoshis: 1_000_000n,
});

const MULTISIG_INPUT_SPEC = {
  txid: MULTISIG_PARENT.txid,
  previousTransactionHex: MULTISIG_PARENT.hex,
  vout: 0,
  satoshis: 1_000_000n,
  lockingBytecodeHex: binToHex(p2shLocking),
  publicKeyHex: binToHex(publicKeys[0]),
  branchIndex: 0 as const,
  addressIndex: 0,
  redeemScriptHex: binToHex(redeemScript),
  requiredSignatures: 2,
  cosignerDerivations: publicKeys.map((publicKey, index) => ({
    publicKeyHex: binToHex(publicKey),
    masterFingerprintHex: binToHex(fingerprints[index]),
    derivationPath: keyPaths[index],
  })),
};

const MULTISIG_INPUT = {
  txid: MULTISIG_INPUT_SPEC.txid,
  vout: MULTISIG_INPUT_SPEC.vout,
  satoshis: MULTISIG_INPUT_SPEC.satoshis,
};

const SOURCE_OUTPUTS = [
  { lockingBytecode: p2shLocking, valueSatoshis: MULTISIG_INPUT.satoshis },
];

function buildMultisigProposal(
  amountSats: bigint
): ReturnType<typeof buildWatchOnlyPsbt> {
  return buildWatchOnlyPsbt({
    inputs: [MULTISIG_INPUT_SPEC],
    recipient: recipientAddress,
    amountSats,
    changeAddress,
    accountPath: ACCOUNT_PATH,
    masterFingerprint: fingerprints[0],
  });
}

/**
 * Sign one input like SeedCash/Paytaca would for a multisig P2SH input.
 *
 * Schnorr by default, because that is what both produce: SeedCash's
 * `sign_tx_input` defaults `use_schnorr=True`, and Paytaca's `createTemplate`
 * defaults `signatureAlgorithm: 'schnorr'`. The algorithm decides the
 * CHECKMULTISIG dummy element, so signing DER here would have quietly tested
 * a path neither signer takes.
 */
function signInput(
  unsignedTxHex: string,
  sourceOutputs: { lockingBytecode: Uint8Array; valueSatoshis: bigint }[],
  inputIndex: number,
  keyIndex: number,
  coveredBytecode: Uint8Array,
  sighashType = 0xc1,
  algorithm: 'schnorr' | 'der' = 'schnorr'
): Uint8Array {
  const noTokens = {
    category: new Uint8Array(),
    amount: 0n,
    nft: undefined,
  };
  const context: CompilationContextBch = {
    transaction: decodeTransaction(hexToBin(unsignedTxHex)),
    inputIndex,
    sourceOutputs: sourceOutputs.map((output) => ({
      lockingBytecode: output.lockingBytecode,
      valueSatoshis: output.valueSatoshis,
      token: noTokens,
    })),
  };
  const serialization = generateSigningSerializationBch(context, {
    coveredBytecode,
    signingSerializationType: Uint8Array.from([sighashType]),
  });
  const messageHash = hash256(serialization);
  const body =
    algorithm === 'schnorr'
      ? secp256k1.signMessageHashSchnorr(privateKeys[keyIndex], messageHash)
      : secp256k1.signMessageHashDER(privateKeys[keyIndex], messageHash);
  return concat([body as Uint8Array, Uint8Array.from([sighashType])]);
}

function wrapWithSignatures(
  proposal: ReturnType<typeof buildWatchOnlyPsbt>,
  sigPerKeyIndex: { keyIndex: number; signature: Uint8Array }[]
): Uint8Array {
  return encodeUnsignedPsbt(
    [
      {
        txid: MULTISIG_INPUT.txid,
        vout: MULTISIG_INPUT.vout,
        satoshis: MULTISIG_INPUT.satoshis,
        lockingBytecode: p2shLocking,
        redeemScript,
        derivations: publicKeys.map((publicKey, index) => ({
          publicKey,
          masterFingerprint: fingerprints[index],
          derivationPath: [
            HARDENED | 44,
            HARDENED | 145,
            HARDENED | 0,
            0,
            index,
          ],
        })),
        partialSignatures: sigPerKeyIndex.map(({ keyIndex, signature }) => ({
          inputIndex: 0,
          publicKey: publicKeys[keyIndex],
          signature,
        })),
      },
    ],
    proposal.outputs.map((output) => ({
      lockingBytecode: hexToBin(output.lockingBytecodeHex),
      satoshis: output.satoshis,
    })),
    0xc1
  );
}

describe('multisig redeem script', () => {
  it('builds OP_m <BIP-67-sorted keys> OP_n OP_CHECKMULTISIG', () => {
    expect(redeemScript[0]).toBe(0x52); // OP_2
    expect(redeemScript[redeemScript.length - 2]).toBe(0x53); // OP_3
    expect(redeemScript[redeemScript.length - 1]).toBe(0xae); // OP_CHECKMULTISIG
    const policy = parseMultisigRedeemScript(redeemScript);
    expect(policy).not.toBeNull();
    expect(policy!.requiredSignatures).toBe(2);
    expect(policy!.totalSignatures).toBe(3);
    const sorted = sortPublicKeysBip67(scrambledKeys).map(binToHex);
    expect(policy!.keys.map(binToHex)).toEqual(sorted);
    expect(policy!.keys.map(binToHex)).not.toEqual(scrambledKeys.map(binToHex));
  });

  it('rejects invalid thresholds', () => {
    expect(() => buildMultisigRedeemScript(publicKeys, 0)).toThrow(/required/i);
    expect(() => buildMultisigRedeemScript(publicKeys, 4)).toThrow(/required/i);
    expect(() => buildMultisigRedeemScript([], 1)).toThrow(/at least one/i);
    expect(() => buildMultisigRedeemScript([publicKeys[0].subarray(0, 32)], 1)).toThrow(/33/i);
  });

  it('parses null for non-multisig scripts', () => {
    expect(parseMultisigRedeemScript(new Uint8Array())).toBeNull();
    expect(isMultisigRedeemScript(new Uint8Array([0x76, 0xa9, 0x14]))).toBe(false);
    expect(isMultisigRedeemScript(redeemScript)).toBe(true);
  });

  it('builds the P2SH20 locking script', () => {
    expect(binToHex(p2shLocking)).toBe(`a914${binToHex(hash160(redeemScript))}87`);
  });
});

describe('cosignerStatuses', () => {
  it('reports every cosigner as unsigned on an empty PSBT', () => {
    const parsed = decodePsbt(wrapWithSignatures(buildMultisigProposal(100_000n), []));
    const statuses = cosignerStatuses(parsed);
    expect(statuses).toHaveLength(1);
    const input: CosignerStatus[] = statuses[0];
    expect(input).toHaveLength(3);
    expect(input.map((s) => s.signed)).toEqual([false, false, false]);
    expect(input[0].fingerprintHex).toBe(binToHex(fingerprints[0]));
    expect(input[0].derivationPath).toBe(`${ACCOUNT_PATH}/0/0`);
  });

  it('marks exactly the keys that have partial signatures', () => {
    const proposal = buildMultisigProposal(100_000n);
    const sig = signInput(
      proposal.rawUnsignedHex,
      SOURCE_OUTPUTS,
      0,
      1,
      redeemScript
    );
    const parsed = decodePsbt(wrapWithSignatures(proposal, [{ keyIndex: 1, signature: sig }]));
    expect(cosignerStatuses(parsed)[0].map((s) => s.signed)).toEqual([false, true, false]);
  });
});

describe('mergePsbts', () => {
  function signerForKey(proposal: ReturnType<typeof buildWatchOnlyPsbt>, keyIndex: number) {
    return signInput(
      proposal.rawUnsignedHex,
      SOURCE_OUTPUTS,
      0,
      keyIndex,
      redeemScript
    );
  }

  it('unions signatures from two 1-of-3 partial PSBTs into 2-of-3', () => {
    const proposal = buildMultisigProposal(100_000n);
    const sigA = signerForKey(proposal, 0);
    const sigB = signerForKey(proposal, 2);
    const psbtA = wrapWithSignatures(proposal, [{ keyIndex: 0, signature: sigA }]);
    const psbtB = wrapWithSignatures(proposal, [{ keyIndex: 2, signature: sigB }]);

    const outcome = mergePsbts([psbtA, psbtB]);
    expect(outcome.results).toEqual([{ index: 1, combined: true }]);

    const merged = decodePsbt(outcome.merged);
    expect(merged.signatures.map((s) => binToHex(s.publicKey)).sort()).toEqual(
      [binToHex(publicKeys[0]), binToHex(publicKeys[2])].sort()
    );
  });

  it('is order-independent', () => {
    const proposal = buildMultisigProposal(100_000n);
    const sigA = signerForKey(proposal, 0);
    const sigB = signerForKey(proposal, 1);
    const psbtA = wrapWithSignatures(proposal, [{ keyIndex: 0, signature: sigA }]);
    const psbtB = wrapWithSignatures(proposal, [{ keyIndex: 1, signature: sigB }]);

    const forward = decodePsbt(mergePsbts([psbtA, psbtB]).merged);
    const reverse = decodePsbt(mergePsbts([psbtB, psbtA]).merged);
    const keysOf = (parsed: ReturnType<typeof decodePsbt>) =>
      parsed.signatures.map((s) => binToHex(s.publicKey)).sort();
    expect(keysOf(forward)).toEqual(keysOf(reverse));
  });

  it('does not require signatures on every candidate', () => {
    const proposal = buildMultisigProposal(100_000n);
    const sigA = signerForKey(proposal, 0);
    const psbtA = wrapWithSignatures(proposal, [{ keyIndex: 0, signature: sigA }]);
    const empty = wrapWithSignatures(proposal, []);

    const outcome = mergePsbts([psbtA, empty]);
    expect(outcome.results).toEqual([{ index: 1, combined: true }]);
    expect(decodePsbt(outcome.merged).signatures).toHaveLength(1);
  });

  it('rejects a candidate bound to a different unsigned transaction', () => {
    const proposalA = buildMultisigProposal(100_000n);
    const proposalB = buildMultisigProposal(150_000n);
    const sigA = signerForKey(proposalA, 0);
    const sigB = signerForKey(proposalB, 1);
    const psbtA = wrapWithSignatures(proposalA, [{ keyIndex: 0, signature: sigA }]);
    const psbtB = wrapWithSignatures(proposalB, [{ keyIndex: 1, signature: sigB }]);

    const outcome = mergePsbts([psbtA, psbtB]);
    expect(outcome.results).toHaveLength(1);
    expect(outcome.results[0].combined).toBe(false);
    expect(outcome.results[0].error).toMatch(/hash mismatch/i);
    // The base must come back unchanged when nothing could be merged.
    expect(binToHex(outcome.merged)).toBe(binToHex(psbtA));
  });

  it('rejects a candidate with a different redeem script', () => {
    const proposal = buildMultisigProposal(100_000n);
    const sig = signerForKey(proposal, 0);
    const otherScript = buildMultisigRedeemScript(publicKeys.slice(0, 2), 1);
    const wrapped = encodeUnsignedPsbt(
      [
        {
          txid: MULTISIG_INPUT.txid,
          vout: MULTISIG_INPUT.vout,
          satoshis: MULTISIG_INPUT.satoshis,
          lockingBytecode: p2shLocking,
          redeemScript: otherScript,
          derivations: publicKeys.map((publicKey, index) => ({
            publicKey,
            masterFingerprint: fingerprints[index],
            derivationPath: [HARDENED | 44, HARDENED | 145, HARDENED | 0, 0, index],
          })),
          partialSignatures: [{ inputIndex: 0, publicKey: publicKeys[0], signature: sig }],
        },
      ],
      proposal.outputs.map((output) => ({
        lockingBytecode: hexToBin(output.lockingBytecodeHex),
        satoshis: output.satoshis,
      })),
      0xc1
    );

    const outcome = mergePsbts([wrapWithSignatures(proposal, []), wrapped]);
    expect(outcome.results[0].combined).toBe(false);
    expect(outcome.results[0].error).toMatch(/redeem script mismatch/i);
  });

  it('rejects a signature from the wrong key', () => {
    const proposal = buildMultisigProposal(100_000n);
    const foreignKey = Uint8Array.from([0xff, ...new Uint8Array(32).fill(0xee)]);
    const sig = signInput(
      proposal.rawUnsignedHex,
      SOURCE_OUTPUTS,
      0,
      0,
      redeemScript
    );
    // Claim the signature under a different pubkey than the one that made it.
    const forged = encodeUnsignedPsbt(
      [
        {
          txid: MULTISIG_INPUT.txid,
          vout: MULTISIG_INPUT.vout,
          satoshis: MULTISIG_INPUT.satoshis,
          lockingBytecode: p2shLocking,
          redeemScript,
          derivations: publicKeys.map((publicKey, index) => ({
            publicKey,
            masterFingerprint: fingerprints[index],
            derivationPath: [HARDENED | 44, HARDENED | 145, HARDENED | 0, 0, index],
          })),
          partialSignatures: [{ inputIndex: 0, publicKey: foreignKey, signature: sig }],
        },
      ],
      proposal.outputs.map((output) => ({
        lockingBytecode: hexToBin(output.lockingBytecodeHex),
        satoshis: output.satoshis,
      })),
      0xc1
    );

    const outcome = mergePsbts([wrapWithSignatures(proposal, []), forged]);
    expect(outcome.results[0].combined).toBe(false);
    expect(outcome.results[0].error).toMatch(/verification/i);
  });

  it('rejects a signature with the wrong sighash type', () => {
    const proposal = buildMultisigProposal(100_000n);
    const sig = signInput(
      proposal.rawUnsignedHex,
      SOURCE_OUTPUTS,
      0,
      0,
      redeemScript,
      0x41
    );
    const wrapped = wrapWithSignatures(proposal, [{ keyIndex: 0, signature: sig }]);
    const outcome = mergePsbts([wrapWithSignatures(proposal, []), wrapped]);
    expect(outcome.results[0].combined).toBe(false);
    expect(outcome.results[0].error).toMatch(/verification/i);
  });

  it('fails only the bad candidate and keeps the good one', () => {
    const proposal = buildMultisigProposal(100_000n);
    const sigA = signerForKey(proposal, 0);
    const sigB = signerForKey(proposal, 1);
    const good = wrapWithSignatures(proposal, [{ keyIndex: 0, signature: sigA }]);
    const bad = wrapWithSignatures(proposal, [{ keyIndex: 1, signature: sigB }]);
    const other = buildMultisigProposal(150_000n);
    const sigOther = signerForKey(other, 0);
    const conflicting = wrapWithSignatures(other, [{ keyIndex: 0, signature: sigOther }]);

    const outcome = mergePsbts([good, bad, conflicting]);
    expect(outcome.results).toEqual([
      { index: 1, combined: true },
      { index: 2, combined: false, error: expect.stringMatching(/hash mismatch/i) },
    ]);
    expect(decodePsbt(outcome.merged).signatures).toHaveLength(2);
  });
});

describe('watch-only multisig send flow', () => {
  it('builds a proposal PSBT with one derivation per cosigner', () => {
    const proposal = buildMultisigProposal(100_000n);
    const parsed = decodePsbt(proposal.psbtBytes);
    expect(parsed.inputs).toHaveLength(1);
    expect(parsed.inputs[0].derivations).toHaveLength(3);
    expect(binToHex(parsed.inputs[0].redeemScript!)).toBe(binToHex(redeemScript));
    expect(binToHex(parsed.inputs[0].spentLockingBytecode!)).toBe(binToHex(p2shLocking));
    expect(parsed.inputs[0].derivations.map((d) => binToHex(d.publicKey))).toEqual(
      publicKeys.map(binToHex)
    );
  });

  it('writes the change output back to the same multisig policy', () => {
    const result = buildWatchOnlyPsbt({
      inputs: [MULTISIG_INPUT_SPEC],
      recipient: recipientAddress,
      amountSats: 100_000n,
      changeAddress,
      accountPath: ACCOUNT_PATH,
      masterFingerprint: fingerprints[0],
      changeRedeemScriptHex: binToHex(redeemScript),
      changeDerivations: publicKeys.map((publicKey, index) => ({
        publicKeyHex: binToHex(publicKey),
        masterFingerprintHex: binToHex(fingerprints[index]),
        derivationPath: keyPaths[index],
      })),
    });
    const parsed = decodePsbt(result.psbtBytes);
    const change = parsed.outputs.find((output) => output.redeemScript);
    expect(change).toBeDefined();
    expect(binToHex(change!.redeemScript!)).toBe(binToHex(redeemScript));
    expect(binToHex(change!.lockingBytecode!)).toBe(binToHex(p2shLocking));
    expect(change!.derivations).toHaveLength(3);
    expect(change!.derivations.map((d) => binToHex(d.publicKey))).toEqual(
      publicKeys.map(binToHex)
    );
  });

  it('rejects a cosigner fingerprint that is not 4 bytes', () => {
    expect(() =>
      buildWatchOnlyPsbt({
        inputs: [
          {
            ...MULTISIG_INPUT_SPEC,
            cosignerDerivations: [
              {
                publicKeyHex: binToHex(publicKeys[0]),
                masterFingerprintHex: 'aabb',
                derivationPath: keyPaths[0],
              },
            ],
          },
        ],
        recipient: recipientAddress,
        amountSats: 100_000n,
        changeAddress,
        accountPath: ACCOUNT_PATH,
        masterFingerprint: fingerprints[0],
      })
    ).toThrow(/fingerprint must be 4 bytes/i);
  });

  it('reports partially-signed until the threshold is met', () => {
    const proposal = buildMultisigProposal(100_000n);
    const sigA = signInput(proposal.rawUnsignedHex, SOURCE_OUTPUTS, 0, 0, redeemScript);
    const oneOfTwo = wrapWithSignatures(proposal, [{ keyIndex: 0, signature: sigA }]);

    const result = inspectImportedPsbt(oneOfTwo, {
      rawUnsignedHex: proposal.rawUnsignedHex,
      inputs: [MULTISIG_INPUT_SPEC],
      outputs: proposal.outputs,
    });
    expect(result.state).toBe('partially-signed');
    expect(result.signedInputCount).toBe(0);
    expect(result.totalInputCount).toBe(1);
  });

  it('completes only when the input has its required signatures', () => {
    const proposal = buildMultisigProposal(100_000n);
    const sourceOutputs = SOURCE_OUTPUTS;
    const sigA = signInput(proposal.rawUnsignedHex, sourceOutputs, 0, 0, redeemScript);
    const sigB = signInput(proposal.rawUnsignedHex, sourceOutputs, 0, 2, redeemScript);
    const partialA = wrapWithSignatures(proposal, [{ keyIndex: 0, signature: sigA }]);
    const partialB = wrapWithSignatures(proposal, [{ keyIndex: 2, signature: sigB }]);
    const merged = mergePsbts([partialA, partialB]).merged;

    const result = inspectImportedPsbt(merged, {
      rawUnsignedHex: proposal.rawUnsignedHex,
      inputs: [MULTISIG_INPUT_SPEC],
      outputs: proposal.outputs,
    });
    expect(result.state).toBe('complete');
    expect(result.signedInputCount).toBe(1);
  });

  it('produces a 2-of-3 unlock that the BCH VM actually accepts', () => {
    // The assertion that matters. A wrong dummy element, a wrong signature
    // order or a wrong checkbits width all survive every structural check and
    // fail only here — which on chain means a transaction that is rejected at
    // broadcast after the hardware has been put away.
    const proposal = buildMultisigProposal(100_000n);
    const sigA = signInput(proposal.rawUnsignedHex, SOURCE_OUTPUTS, 0, 0, redeemScript);
    const sigB = signInput(proposal.rawUnsignedHex, SOURCE_OUTPUTS, 0, 2, redeemScript);
    const merged = mergePsbts([
      wrapWithSignatures(proposal, [{ keyIndex: 0, signature: sigA }]),
      wrapWithSignatures(proposal, [{ keyIndex: 2, signature: sigB }]),
    ]).merged;

    const rawTxHex = mergeImportedSignatures(merged, {
      rawUnsignedHex: proposal.rawUnsignedHex,
      inputs: [MULTISIG_INPUT_SPEC],
      outputs: proposal.outputs,
    });
    const transaction = decodeTransaction(hexToBin(rawTxHex));
    if (typeof transaction === 'string') throw new Error(transaction);

    const vm = createVirtualMachineBCH();
    expect(
      vm.verify({
        sourceOutputs: [
          { lockingBytecode: p2shLocking, valueSatoshis: MULTISIG_INPUT.satoshis },
        ],
        transaction,
      })
    ).toBe(true);
  });

  it('falls back to the legacy OP_0 dummy for ECDSA signatures', () => {
    // Paytaca templates can be built with `signatureAlgorithm: 'ecdsa'`, and
    // that mode still takes the null dummy. The VM is the arbiter for both.
    const proposal = buildMultisigProposal(100_000n);
    const sign = (keyIndex: number) =>
      signInput(proposal.rawUnsignedHex, SOURCE_OUTPUTS, 0, keyIndex, redeemScript, 0xc1, 'der');
    const sigA = sign(0);
    const sigB = sign(2);
    const merged = mergePsbts([
      wrapWithSignatures(proposal, [{ keyIndex: 0, signature: sigA }]),
      wrapWithSignatures(proposal, [{ keyIndex: 2, signature: sigB }]),
    ]).merged;

    const rawTxHex = mergeImportedSignatures(merged, {
      rawUnsignedHex: proposal.rawUnsignedHex,
      inputs: [MULTISIG_INPUT_SPEC],
      outputs: proposal.outputs,
    });
    const transaction = decodeTransaction(hexToBin(rawTxHex));
    if (typeof transaction === 'string') throw new Error(transaction);
    expect(transaction.inputs[0].unlockingBytecode[0]).toBe(0x00);

    const vm = createVirtualMachineBCH();
    expect(
      vm.verify({
        sourceOutputs: [
          { lockingBytecode: p2shLocking, valueSatoshis: MULTISIG_INPUT.satoshis },
        ],
        transaction,
      })
    ).toBe(true);
  });

  it('refuses to mix Schnorr and ECDSA signatures on one input', () => {
    // CHECKMULTISIG carries one dummy for the whole input, so a mixed set has
    // no correct encoding. Better to say so than to guess and fail at broadcast.
    const proposal = buildMultisigProposal(100_000n);
    const schnorr = signInput(proposal.rawUnsignedHex, SOURCE_OUTPUTS, 0, 0, redeemScript);
    const der = signInput(proposal.rawUnsignedHex, SOURCE_OUTPUTS, 0, 2, redeemScript, 0xc1, 'der');
    const merged = mergePsbts([
      wrapWithSignatures(proposal, [{ keyIndex: 0, signature: schnorr }]),
      wrapWithSignatures(proposal, [{ keyIndex: 2, signature: der }]),
    ]).merged;

    expect(() =>
      mergeImportedSignatures(merged, {
        rawUnsignedHex: proposal.rawUnsignedHex,
        inputs: [MULTISIG_INPUT_SPEC],
        outputs: proposal.outputs,
      })
    ).toThrow(/same algorithm/i);
  });

  it('merges into a broadcastable checkbits ... OP_CHECKMULTISIG unlock', () => {
    const proposal = buildMultisigProposal(100_000n);
    const sourceOutputs = SOURCE_OUTPUTS;
    const sigA = signInput(proposal.rawUnsignedHex, sourceOutputs, 0, 0, redeemScript);
    const sigB = signInput(proposal.rawUnsignedHex, sourceOutputs, 0, 2, redeemScript);
    const partialA = wrapWithSignatures(proposal, [{ keyIndex: 0, signature: sigA }]);
    const partialB = wrapWithSignatures(proposal, [{ keyIndex: 2, signature: sigB }]);
    const merged = mergePsbts([partialA, partialB]).merged;

    const rawTxHex = mergeImportedSignatures(merged, {
      rawUnsignedHex: proposal.rawUnsignedHex,
      inputs: [MULTISIG_INPUT_SPEC],
      outputs: proposal.outputs,
    });
    const tx = decodeTransaction(hexToBin(rawTxHex));
    if (typeof tx === 'string') throw new Error(tx);
    const unlocking = tx.inputs[0].unlockingBytecode;

    // <checkbits> <sigA> <sigB> <redeemScript>, signatures in BIP-67 key order
    // regardless of the order they were merged in. The dummy is a Schnorr
    // checkbits bit field naming the two keys that signed, not the legacy OP_0
    // null — Paytaca's templates default to schnorr, and so does SeedCash.
    const sortedHex = sortPublicKeysBip67(publicKeys).map(binToHex);
    const positionOf = (publicKey: Uint8Array) =>
      sortedHex.indexOf(binToHex(publicKey));
    const sigsByPosition = new Map<number, Uint8Array>();
    sigsByPosition.set(positionOf(publicKeys[0]), sigA);
    sigsByPosition.set(positionOf(publicKeys[2]), sigB);
    const positions = [...sigsByPosition.keys()].sort((a, b) => a - b);
    const expected = concat([
      pushMinimal(schnorrCheckBits(positions, publicKeys.length)),
      pushData(sigsByPosition.get(positions[0])!),
      pushData(sigsByPosition.get(positions[1])!),
      pushData(redeemScript),
    ]);
    expect(binToHex(unlocking)).toBe(binToHex(expected));
    // Two of three keys signed, so exactly two bits are set.
    expect(schnorrCheckBits(positions, 3)).toHaveLength(1);
    expect(unlocking[0]).not.toBe(0x00);
  });

  it('rejects a 2-of-3 PSBT that only carries one valid signature', () => {
    const proposal = buildMultisigProposal(100_000n);
    const sourceOutputs = SOURCE_OUTPUTS;
    const sigA = signInput(proposal.rawUnsignedHex, sourceOutputs, 0, 0, redeemScript);
    const oneOfTwo = wrapWithSignatures(proposal, [{ keyIndex: 0, signature: sigA }]);
    expect(() =>
      mergeImportedSignatures(oneOfTwo, {
        rawUnsignedHex: proposal.rawUnsignedHex,
        inputs: [MULTISIG_INPUT_SPEC],
        outputs: proposal.outputs,
      })
    ).toThrow(/needs 2 verified multisig signatures/);
  });
});
