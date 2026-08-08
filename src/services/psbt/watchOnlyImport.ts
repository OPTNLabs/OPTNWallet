// Watch-only import verifier: bind a signed PSBT to the approved proposal,
// verify every signature locally, and merge into a broadcastable raw tx.
//
// The flow: the signer (SeedCash) returns a PSBT over `ur:crypto-psbt`. Before
// anything is broadcast, this module
//   1. binds the returned PSBT to the exact unsigned transaction that was
//      approved (byte-for-byte),
//   2. checks the requested sighash type was honoured (0xc1),
//   3. cryptographically verifies every partial signature against the
//      public key and the BCH signing serialization for the spent output,
//   4. merges the signatures into a final raw transaction.
//
// Anything that fails any of these gates never reaches broadcast.

import {
  binToHex,
  decodeTransaction,
  encodeTransaction,
  generateSigningSerializationBch,
  hash256,
  hexToBin,
  type CompilationContextBch,
} from '@bitauth/libauth';

import {
  decodePsbt,
  sighashTypeOf,
  verifyBchSignature,
  SCHNORR_SIGNATURE_LENGTH,
  SIGHASH_ALL_FORKID_ANYONECANPAY,
  type PsbtSignature,
} from './psbtBch';
import {
  parseMultisigRedeemScript,
  pushData,
  pushMinimal,
  schnorrCheckBits,
  OP_0,
} from './psbtMultisig';
import type { WatchOnlyProposal } from './watchOnlySend';

export type WatchOnlyImportState =
  | 'unsigned'
  | 'partially-signed'
  | 'complete'
  | 'invalid'
  | 'rejected';

export interface WatchOnlyImportResult {
  state: WatchOnlyImportState;
  /** Why the import was rejected or marked invalid. */
  reason?: string;
  /** The final signed raw transaction, hex — only when complete. */
  rawTxHex?: string;
  /** Number of inputs with a valid signature. */
  signedInputCount: number;
  totalInputCount: number;
}

function verifyPartialSignature(
  signature: PsbtSignature,
  proposal: WatchOnlyProposal,
  unsignedTxBytes: Uint8Array
): boolean {
  const type = sighashTypeOf(signature.signature);
  if (type === null) return false;
  if (type !== SIGHASH_ALL_FORKID_ANYONECANPAY) return false;

  const input = proposal.inputs[signature.inputIndex];
  if (!input) return false;
  // For a P2SH (multisig) input the sighash commits to the redeem script,
  // not the P2SH locking bytecode — BIP143-style scriptCode rules.
  const coveredBytecode = input.redeemScriptHex
    ? hexToBin(input.redeemScriptHex)
    : hexToBin(input.lockingBytecodeHex);
  const decoded = decodeTransaction(unsignedTxBytes);
  if (typeof decoded === 'string') return false;
  // A no-token output must serialize with an empty token prefix; `token`
  // undefined is what the encoder expects for that.
  const noTokens = {
    category: new Uint8Array(),
    amount: 0n,
    nft: undefined,
  };
  const context: CompilationContextBch = {
    transaction: decoded as CompilationContextBch['transaction'],
    inputIndex: signature.inputIndex,
    // sourceOutputs is indexed by input; every input's spent output must be
    // present, not just the one being verified.
    sourceOutputs: proposal.inputs.map((candidate) => ({
      lockingBytecode: hexToBin(candidate.lockingBytecodeHex),
      valueSatoshis: candidate.satoshis,
      token: noTokens,
    })),
  };
  const serialization = generateSigningSerializationBch(
    context,
    {
      coveredBytecode,
      signingSerializationType: Uint8Array.from([type]),
    }
  );
  const messageHash = hash256(serialization);
  return verifyBchSignature(
    signature.signature.subarray(0, -1),
    signature.publicKey,
    messageHash
  );
}

/**
 * Inspect a PSBT returned by the signer against the proposal that was
 * approved. Throws when the payload is not a parseable PSBT; returns a state
 * (never throws) for signature problems so the UI can show a state card.
 */
export function inspectImportedPsbt(
  imported: Uint8Array,
  proposal: WatchOnlyProposal
): WatchOnlyImportResult {
  const parsed = decodePsbt(imported);

  const boundTxHex = binToHex(parsed.unsignedTransaction);
  if (boundTxHex !== proposal.rawUnsignedHex) {
    return {
      state: 'rejected',
      reason:
        'The returned PSBT contains a different unsigned transaction than the one approved. ' +
        'Compare the destination, amount, change, and inputs on the device before signing again.',
      signedInputCount: 0,
      totalInputCount: proposal.inputs.length,
    };
  }

  if (parsed.inputs.length !== proposal.inputs.length) {
    return {
      state: 'rejected',
      reason: 'The returned PSBT has a different number of inputs than approved.',
      signedInputCount: 0,
      totalInputCount: proposal.inputs.length,
    };
  }

  const validPerInput = parsed.inputs.map((parsedInput, inputIndex) => {
    const required = proposal.inputs[inputIndex]?.requiredSignatures ?? 1;
    const verified = parsedInput.partialSignatures.filter(
      (signature) =>
        signature.inputIndex === inputIndex &&
        verifyPartialSignature(signature, proposal, parsed.unsignedTransaction)
    );
    return verified.length >= required;
  });

  const signedInputCount = validPerInput.filter(Boolean).length;
  const invalidSignaturePresent = parsed.signatures.some((signature) => {
    const type = sighashTypeOf(signature.signature);
    return (
      type === null ||
      type !== SIGHASH_ALL_FORKID_ANYONECANPAY ||
      !verifyPartialSignature(signature, proposal, parsed.unsignedTransaction)
    );
  });

  if (signedInputCount === 0 && parsed.signatures.length === 0) {
    return {
      state: 'unsigned',
      reason: 'The signer returned the transaction without any signatures.',
      signedInputCount: 0,
      totalInputCount: proposal.inputs.length,
    };
  }
  if (invalidSignaturePresent) {
    return {
      state: 'invalid',
      reason:
        'At least one signature does not verify against the approved transaction. ' +
        'It may have been signed with a different key, amount, or sighash type. Do not broadcast.',
      signedInputCount,
      totalInputCount: proposal.inputs.length,
    };
  }
  if (signedInputCount < proposal.inputs.length) {
    return {
      state: 'partially-signed',
      reason: `Signed ${signedInputCount} of ${proposal.inputs.length} inputs. ` +
        'Return it to the device for the remaining signatures.',
      signedInputCount,
      totalInputCount: proposal.inputs.length,
    };
  }
  return {
    state: 'complete',
    signedInputCount,
    totalInputCount: proposal.inputs.length,
  };
}

/**
 * Build the unlocking script for one input from its verified signatures.
 *
 * P2PKH: `<sig+sighash> <pubkey>`. Multisig P2SH:
 * `<dummy> <sig1> <sig2> ... <redeemScript>` with the signatures ordered by
 * each key's position in the BIP-67-sorted redeem script, because that is the
 * order CHECKMULTISIG walks them in.
 *
 * The dummy follows the signature algorithm, not a fixed convention: Schnorr
 * signatures need a checkbits bit field naming the signing keys, ECDSA keeps
 * the legacy null OP_0. BCH tells the two apart by signature length, so that
 * is what decides here too. Mixing algorithms inside one CHECKMULTISIG is not
 * expressible — the dummy is per-input, not per-signature — so it is refused
 * rather than silently resolved one way.
 */
function buildUnlockScript(
  signatures: PsbtSignature[],
  publicKey: Uint8Array,
  multisig?: {
    redeemScriptHex: string;
    keyPositions: number[];
    totalKeys: number;
  }
): Uint8Array {
  if (!multisig) {
    const signature = signatures[0];
    const script = new Uint8Array(
      signature.signature.length + publicKey.length + 2
    );
    script[0] = signature.signature.length;
    script.set(signature.signature, 1);
    script[signature.signature.length + 1] = publicKey.length;
    script.set(publicKey, signature.signature.length + 2);
    return script;
  }

  const schnorrCount = signatures.filter(
    (candidate) =>
      candidate.signature.length - 1 === SCHNORR_SIGNATURE_LENGTH
  ).length;
  if (schnorrCount !== 0 && schnorrCount !== signatures.length) {
    throw new Error(
      'This input mixes Schnorr and ECDSA signatures. CHECKMULTISIG carries ' +
        'one dummy for the whole input, so every cosigner must sign with the ' +
        'same algorithm.'
    );
  }

  const dummy =
    schnorrCount === signatures.length
      ? pushMinimal(
          schnorrCheckBits(multisig.keyPositions, multisig.totalKeys)
        )
      : Uint8Array.of(OP_0);

  const parts = [dummy];
  for (const signature of signatures) parts.push(pushData(signature.signature));
  parts.push(pushData(hexToBin(multisig.redeemScriptHex)));
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const script = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    script.set(part, offset);
    offset += part.length;
  }
  return script;
}

/**
 * Merge the verified signatures into a final raw transaction.
 *
 * Only call after `inspectImportedPsbt` returned `complete` — this does not
 * re-verify. For multisig inputs the signatures are ordered by each signer's
 * key position in the BIP-67-sorted redeem script and the unlock is
 * `OP_0 <sig>... <redeemScript>`.
 */
export function mergeImportedSignatures(
  imported: Uint8Array,
  proposal: WatchOnlyProposal
): string {
  const parsed = decodePsbt(imported);
  if (parsed.inputs.length !== proposal.inputs.length) {
    throw new Error('Imported PSBT does not match the proposal input count.');
  }

  const unlockPerInput = parsed.inputs.map((parsedInput, index) => {
    const verified = parsedInput.partialSignatures.filter(
      (candidate) =>
        candidate.inputIndex === index &&
        verifyPartialSignature(candidate, proposal, parsed.unsignedTransaction)
    );
    if (verified.length === 0) {
      throw new Error(`Input ${index} has no verified signature to merge.`);
    }

    const proposalInput = proposal.inputs[index];
    if (proposalInput.redeemScriptHex) {
      const required = proposalInput.requiredSignatures ?? verified.length;
      const policy = parseMultisigRedeemScript(
        hexToBin(proposalInput.redeemScriptHex)
      );
      if (!policy) {
        throw new Error(`Input ${index} has an invalid multisig redeem script.`);
      }
      // CHECKMULTISIG reads signatures in redeem-script key order; take the
      // first `required` verified signatures in that order.
      const keyPosition = new Map(
        policy.keys.map((key, position) => [binToHex(key), position])
      );
      const ordered = verified
        .filter((candidate) => keyPosition.has(binToHex(candidate.publicKey)))
        .sort(
          (a, b) =>
            keyPosition.get(binToHex(a.publicKey))! -
            keyPosition.get(binToHex(b.publicKey))!
        )
        .slice(0, required);
      if (ordered.length < required) {
        throw new Error(
          `Input ${index} needs ${required} verified multisig signatures, ` +
            `got ${ordered.length}.`
        );
      }
      return {
        script: buildUnlockScript(ordered, ordered[0].publicKey, {
          redeemScriptHex: proposalInput.redeemScriptHex,
          keyPositions: ordered.map(
            (candidate) => keyPosition.get(binToHex(candidate.publicKey))!
          ),
          totalKeys: policy.keys.length,
        }),
      };
    }

    return {
      script: buildUnlockScript(verified, verified[0].publicKey),
    };
  });

  const encoded = encodeTransaction({
    version: 2,
    inputs: proposal.inputs.map((input, index) => ({
      outpointTransactionHash: hexToBin(input.txid),
      outpointIndex: input.vout,
      unlockingBytecode: unlockPerInput[index].script,
      sequenceNumber: 0xffffffff,
    })),
    outputs: proposal.outputs.map((output) => ({
      lockingBytecode: hexToBin(output.lockingBytecodeHex),
      valueSatoshis: output.satoshis,
    })),
    locktime: 0,
  });

  return binToHex(encoded);
}
