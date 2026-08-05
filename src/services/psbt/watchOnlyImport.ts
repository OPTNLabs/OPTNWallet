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
  secp256k1,
  type CompilationContextBch,
} from '@bitauth/libauth';

import {
  decodePsbt,
  sighashTypeOf,
  SIGHASH_ALL_FORKID_ANYONECANPAY,
  type PsbtSignature,
} from './psbtBch';
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
  const lockingBytecode = hexToBin(input.lockingBytecodeHex);
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
      coveredBytecode: lockingBytecode,
      signingSerializationType: Uint8Array.from([type]),
    }
  );
  const messageHash = hash256(serialization);
  return secp256k1.verifySignatureDER(
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

  const validPerInput = parsed.inputs.map((parsedInput) => {
    const signatures = parsedInput.partialSignatures;
    if (signatures.length === 0) return false;
    return signatures.some((signature) =>
      verifyPartialSignature(signature, proposal, parsed.unsignedTransaction)
    );
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
 * Merge the verified signatures into a final raw transaction.
 *
 * Only call after `inspectImportedPsbt` returned `complete` — this does not
 * re-verify. The unlocking script is `<sig+sighash> <pubkey>` (P2PKH), which
 * is the only script shape a watch-only BIP44 wallet spends.
 */
export function mergeImportedSignatures(
  imported: Uint8Array,
  proposal: WatchOnlyProposal
): string {
  const parsed = decodePsbt(imported);
  if (parsed.inputs.length !== proposal.inputs.length) {
    throw new Error('Imported PSBT does not match the proposal input count.');
  }

  const unlockPerInput = parsed.inputs.map((parsedInput, index) => {    const signature = parsedInput.partialSignatures.find((candidate) => {
      const matchesInput = candidate.inputIndex === index;
      return (
        matchesInput &&
        verifyPartialSignature(candidate, proposal, parsed.unsignedTransaction)
      );
    });
    if (!signature) {
      throw new Error(`Input ${index} has no verified signature to merge.`);
    }
    return {
      publicKey: signature.publicKey,
      signature: signature.signature,
    };
  });

  const encoded = encodeTransaction({
    version: 2,
    inputs: proposal.inputs.map((input, index) => ({
      outpointTransactionHash: hexToBin(input.txid),
      outpointIndex: input.vout,
      unlockingBytecode: (() => {
        const { signature, publicKey } = unlockPerInput[index];
        const script = new Uint8Array(signature.length + publicKey.length + 2);
        script[0] = signature.length;
        script.set(signature, 1);
        script[signature.length + 1] = publicKey.length;
        script.set(publicKey, signature.length + 2);
        return script;
      })(),
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
