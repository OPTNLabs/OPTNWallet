// Multisig policy for the watch-only PSBT flow, matched to Paytaca's
// implementation (paytaca-app src/lib/multisig):
//
//   * Redeem script: `OP_m <pubkey>... <pubkey> OP_n OP_CHECKMULTISIG` where
//     the public keys are sorted lexicographically (BIP-67, the `bip67Sort`
//     default in wallet-keys.js — `signer.publicKey.localeCompare(...)` on hex).
//   * Addresses: P2SH20 of that redeem script (the 2-of-3 template uses
//     `"lockingType": "p2sh20"`).
//   * Unlock: `OP_0 <sig1> <sig2> ... <redeemScript>` — Paytaca's templates
//     still emit the OP_0 dummy byte even though BCH consensus stopped
//     consuming it, and the unlock here matches byte-for-byte.
//   * Merge: `Psbt.combine(psbts)` — bind every candidate to the same unsigned
//     transaction (hash mismatch is a hard rejection), require the same input
//     count and redeem scripts, cryptographically verify every partial
//     signature against the candidate's own carried context, and only then
//     import it into the base. One bad PSBT fails alone; the rest still merge.

import {
  binToHex,
  decodeTransaction,
  generateSigningSerializationBch,
  hash160,
  hash256,
  secp256k1,
  type CompilationContextBch,
} from '@bitauth/libauth';

import {
  decodePsbt,
  encodeUnsignedPsbt,
  sighashTypeOf,
  SIGHASH_ALL_FORKID_ANYONECANPAY,
  type ParsedPsbt,
  type ParsedPsbtInput,
  type PsbtInputSpec,
  type PsbtOutputSpec,
  type PsbtSignature,
} from './psbtBch';

export const OP_CHECKMULTISIG = 0xae;
export const OP_HASH160 = 0xa9;
export const OP_EQUAL = 0x87;
export const PUSHDATA1 = 0x4c;

/**
 * BIP-67: lexicographic ordering of compressed public keys, the script
 * ordering Paytaca uses for its multisig redeem scripts.
 */
export function sortPublicKeysBip67(publicKeys: Uint8Array[]): Uint8Array[] {
  return [...publicKeys].sort((a, b) => {
    const length = Math.min(a.length, b.length);
    for (let i = 0; i < length; i += 1) {
      if (a[i] !== b[i]) return a[i] - b[i];
    }
    return a.length - b.length;
  });
}

function opcodeForSmallInteger(value: number): number {
  if (value < 1 || value > 16) {
    throw new Error(`Multisig thresholds must be between 1 and 16 (got ${value}).`);
  }
  return 0x50 + value; // OP_1 (0x51) .. OP_16 (0x60)
}

/** The standard push for a 33-byte compressed public key. */
function push33(bytes: Uint8Array): Uint8Array {
  if (bytes.length !== 33) {
    throw new Error('Multisig public keys must be compressed (33 bytes).');
  }
  return new Uint8Array([33, ...bytes]);
}

/**
 * `OP_m <keys...> OP_n OP_CHECKMULTISIG` with BIP-67-sorted keys — the exact
 * script Paytaca's `generateRedeemScript` produces.
 */
export function buildMultisigRedeemScript(
  publicKeys: Uint8Array[],
  requiredSignatures: number
): Uint8Array {
  if (publicKeys.length === 0) {
    throw new Error('A multisig redeem script needs at least one public key.');
  }
  if (requiredSignatures < 1 || requiredSignatures > publicKeys.length) {
    throw new Error(
      `Required signatures must be between 1 and ${publicKeys.length}.`
    );
  }
  const sorted = sortPublicKeysBip67(publicKeys);
  const parts = [Uint8Array.from([opcodeForSmallInteger(requiredSignatures)])];
  for (const key of sorted) parts.push(push33(key));
  parts.push(
    Uint8Array.from([opcodeForSmallInteger(publicKeys.length), OP_CHECKMULTISIG])
  );
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export interface MultisigScriptPolicy {
  requiredSignatures: number;
  totalSignatures: number;
  /** Keys in redeem-script order (BIP-67 sorted). */
  keys: Uint8Array[];
}

/**
 * Parse `OP_m <push33>... OP_n OP_CHECKMULTISIG` back into its parts, or null
 * when the script is not that shape.
 */
export function parseMultisigRedeemScript(
  script: Uint8Array
): MultisigScriptPolicy | null {
  const smallInteger = (opcode: number): number | null =>
    opcode >= 0x51 && opcode <= 0x60 ? opcode - 0x50 : null;

  const required = smallInteger(script[0]);
  if (required === null) return null;

  const keys: Uint8Array[] = [];
  let offset = 1;
  for (;;) {
    const push = script[offset];
    if (push === undefined) return null;
    if (push === 33) {
      const key = script.subarray(offset + 1, offset + 34);
      if (key.length !== 33) return null;
      keys.push(key);
      offset += 34;
      continue;
    }
    const total = smallInteger(push);
    if (total === null || script[offset + 1] !== OP_CHECKMULTISIG) return null;
    if (total !== keys.length) return null;
    return {
      requiredSignatures: required,
      totalSignatures: total,
      keys,
    };
  }
}

export function isMultisigRedeemScript(script: Uint8Array): boolean {
  return parseMultisigRedeemScript(script) !== null;
}

/** P2SH20 locking script for a redeem script (HASH160 <hash> EQUAL). */
export function p2shLockingBytecodeFor(redeemScript: Uint8Array): Uint8Array {
  const hash = hash160(redeemScript);
  return new Uint8Array([
    OP_HASH160,
    0x14,
    ...hash,
    OP_EQUAL,
  ]);
}

/** Script push for one payload: direct length byte, or PUSHDATA1 for longer data. */
export function pushData(payload: Uint8Array): Uint8Array {
  const header =
    payload.length <= 75
      ? new Uint8Array([payload.length])
      : new Uint8Array([PUSHDATA1, payload.length]);
  return new Uint8Array([...header, ...payload]);
}

/** Human-readable BIP32 path for display and cosigner tracking. */
export function formatBip32Path(path: number[]): string {
  return `m/${path
    .map((level) =>
      level & 0x80000000 ? `${level & 0x7fffffff}'` : String(level)
    )
    .join('/')}`;
}

export interface CosignerStatus {
  /** 4-byte master fingerprint, hex. */
  fingerprintHex: string;
  /** Compressed public key at this input's derivation path, hex. */
  publicKeyHex: string;
  derivationPath: string;
  /** Whether a partial signature for this key is present in the PSBT. */
  signed: boolean;
}

/**
 * Track which cosigner fingerprints have signed, per input, entirely from
 * public PSBT material — no private key is ever needed to report this.
 */
export function cosignerStatuses(parsed: ParsedPsbt): CosignerStatus[][] {
  return parsed.inputs.map((input) => {
    const signedKeys = new Set(
      input.partialSignatures.map((signature) => binToHex(signature.publicKey))
    );
    return input.derivations.map((derivation) => ({
      fingerprintHex: binToHex(derivation.masterFingerprint),
      publicKeyHex: binToHex(derivation.publicKey),
      derivationPath: formatBip32Path(derivation.derivationPath),
      signed: signedKeys.has(binToHex(derivation.publicKey)),
    }));
  });
}

export interface PsbtMergeResult {
  index: number;
  combined: boolean;
  error?: string;
}

export interface PsbtMergeOutcome {
  /** The base PSBT with every verified signature imported (re-encoded). */
  merged: Uint8Array;
  /** Per-candidate verdicts; one failure does not block the others. */
  results: PsbtMergeResult[];
}

const NO_TOKENS = {
  category: new Uint8Array(),
  amount: 0n,
  nft: undefined,
};

/**
 * Verify a partial signature against everything the PSBT itself carries
 * (unsigned transaction, spent output, redeem script), like Paytaca's
 * `verifyTransactionInputSignature` inside `combine()`.
 */
function verifySignatureForPsbt(
  signature: PsbtSignature,
  parsed: ParsedPsbt,
  parsedInput: ParsedPsbtInput
): boolean {
  const type = sighashTypeOf(signature.signature);
  if (type === null || type !== SIGHASH_ALL_FORKID_ANYONECANPAY) return false;

  const coveredBytecode =
    parsedInput.redeemScript ?? parsedInput.spentLockingBytecode;
  const valueSatoshis = parsedInput.spentSatoshis;
  if (!coveredBytecode || valueSatoshis === null) return false;

  const decoded = decodeTransaction(parsed.unsignedTransaction);
  if (typeof decoded === 'string') return false;

  // Token-carrying inputs are outside the air-gapped multisig scope; the
  // spent output is treated as token-free, exactly like the import verifier.
  const context: CompilationContextBch = {
    transaction: decoded as CompilationContextBch['transaction'],
    inputIndex: signature.inputIndex,
    sourceOutputs: parsed.inputs.map((input) => ({
      lockingBytecode: input.spentLockingBytecode ?? new Uint8Array(),
      valueSatoshis: input.spentSatoshis ?? 0n,
      token: NO_TOKENS,
    })),
  };
  const serialization = generateSigningSerializationBch(context, {
    coveredBytecode,
    signingSerializationType: Uint8Array.from([type]),
  });
  const messageHash = hash256(serialization);
  return secp256k1.verifySignatureDER(
    signature.signature.subarray(0, -1),
    signature.publicKey,
    messageHash
  );
}

/**
 * Re-encode a parsed PSBT, replacing its input maps with the merged signature
 * union. The unsigned transaction is regenerated from the same inputs and
 * outputs, so it stays byte-identical to the original base.
 */
function encodeFromParsed(
  parsed: ParsedPsbt,
  signatures: Map<string, PsbtSignature>
): Uint8Array {
  const requested = parsed.requestedSighashTypes.filter(
    (type): type is number => type !== null
  );
  let sighashType = SIGHASH_ALL_FORKID_ANYONECANPAY;
  if (requested.length > 0) {
    if (requested.some((type) => type !== requested[0])) {
      throw new Error(
        'Cannot merge PSBTs that request different sighash types.'
      );
    }
    sighashType = requested[0];
  }

  const inputs: PsbtInputSpec[] = parsed.inputs.map((input, index) => {
    if (
      !input.previousTxid ||
      input.outpointIndex === null ||
      input.spentSatoshis === null ||
      !input.spentLockingBytecode
    ) {
      throw new Error(`PSBT input ${index} is missing its spent-output data.`);
    }
    return {
      txid: binToHex(input.previousTxid),
      vout: input.outpointIndex,
      satoshis: input.spentSatoshis,
      lockingBytecode: input.spentLockingBytecode,
      redeemScript: input.redeemScript ?? undefined,
      derivations:
        input.derivations.length > 0 ? input.derivations : undefined,
      sequence: input.sequence ?? 0xffffffff,
      partialSignatures: Array.from(signatures.values()).filter(
        (signature) => signature.inputIndex === index
      ),
    };
  });

  const outputs: PsbtOutputSpec[] = parsed.outputs.map((output) => ({
    lockingBytecode: output.lockingBytecode ?? new Uint8Array(),
    satoshis: output.satoshis ?? 0n,
    redeemScript: output.redeemScript ?? undefined,
    token: output.token ?? undefined,
    derivations:
      output.derivations.length > 0 ? output.derivations : undefined,
  }));

  return encodeUnsignedPsbt(inputs, outputs, sighashType, {
    globalXpubs:
      parsed.globalXpubs.length > 0 ? parsed.globalXpubs : undefined,
  });
}

/**
 * Merge partially signed PSBTs into the first one, matching Paytaca's
 * `Psbt.combine(psbts)` contract:
 *
 *   1. the candidate's unsigned transaction must be identical to the base
 *      (a conflicting transaction is rejected, never silently replaced),
 *   2. the input counts must match,
 *   3. per input, the redeem scripts must match,
 *   4. every partial signature is cryptographically verified against the
 *      candidate's own carried context before being imported,
 *   5. a failing candidate is reported on its own; the others still merge.
 */
export function mergePsbts(psbts: Uint8Array[]): PsbtMergeOutcome {
  if (psbts.length === 0) {
    throw new Error('mergePsbts needs at least one PSBT.');
  }

  const baseParsed = decodePsbt(psbts[0]);
  const baseTxHex = binToHex(baseParsed.unsignedTransaction);
  const results: PsbtMergeResult[] = [];
  const signatureUnion = new Map<string, PsbtSignature>();
  for (const signature of baseParsed.signatures) {
    signatureUnion.set(
      `${signature.inputIndex}:${binToHex(signature.publicKey)}`,
      signature
    );
  }

  for (let i = 1; i < psbts.length; i += 1) {
    try {
      const candidate = decodePsbt(psbts[i]);
      if (binToHex(candidate.unsignedTransaction) !== baseTxHex) {
        throw new Error(
          `Unsigned transaction hash mismatch with PSBT at index ${i}.`
        );
      }
      if (candidate.inputs.length !== baseParsed.inputs.length) {
        throw new Error(
          `Input count mismatch at index ${i}. Expected ${baseParsed.inputs.length}, ` +
            `got ${candidate.inputs.length}.`
        );
      }
      for (const [inputIndex, candidateInput] of candidate.inputs.entries()) {
        const baseInput = baseParsed.inputs[inputIndex];
        const candidateRedeem = candidateInput.redeemScript
          ? binToHex(candidateInput.redeemScript)
          : null;
        const baseRedeem = baseInput.redeemScript
          ? binToHex(baseInput.redeemScript)
          : null;
        if (candidateRedeem !== baseRedeem) {
          throw new Error(
            `Redeem script mismatch between base input and target input at index ${inputIndex}.`
          );
        }
        for (const signature of candidateInput.partialSignatures) {
          if (!verifySignatureForPsbt(signature, candidate, candidateInput)) {
            throw new Error(
              `Failed signature verification on PSBT at index ${i}, input ${inputIndex}.`
            );
          }
          signatureUnion.set(
            `${inputIndex}:${binToHex(signature.publicKey)}`,
            { ...signature, inputIndex }
          );
        }
      }
      results.push({ index: i, combined: true });
    } catch (error) {
      results.push({
        index: i,
        combined: false,
        error:
          error instanceof Error ? error.message : 'Could not merge PSBT.',
      });
    }
  }

  if (results.some((result) => result.combined)) {
    return {
      merged: encodeFromParsed(baseParsed, signatureUnion),
      results,
    };
  }
  return { merged: psbts[0], results };
}
