/**
 * WizardConnect sign-in proofs.
 *
 * WizardConnect (hdwalletv1) has no message signing, only sign_transaction.
 * Some dApps (Badger Survivors' editor, v0.545+) prove control of an address
 * by asking the wallet to sign a transaction that can never be mined:
 *
 *   input 0   outpoint sha256(outpointTag + code):0, worth 1000 sats, P2PKH
 *             to the address being proven. No real transaction has that txid,
 *             so the signed result spends nothing and cannot be broadcast.
 *   output 0  OP_RETURN <tag> <code>, 0 sats
 *   output 1  1000 sats back to the same address
 *   version 2, locktime 0, signed SIGHASH_ALL|UTXOS|FORKID (0x61)
 *
 * The wallet does not trust the dApp's transaction. It takes only the scheme
 * tag and the one-time code from the request, rebuilds the canonical proof
 * itself, and refuses unless the dApp's request is byte-identical to it. A
 * request that carries a registered tag but differs in any way (another
 * input, a real outpoint, a changed output or value, a token, a contract) is
 * refused outright rather than signed as a normal payment.
 *
 * Because the signature commits to every output and to the (fake) source
 * output, a server can rebuild the same transaction from the code it issued
 * and the address it expects, check that the unlocking public key hashes to
 * that address, and run the BCH VM over it.
 */
import {
  binToHex,
  binToUtf8,
  decodeAuthenticationInstructions,
  decodeTransaction,
  encodeTransaction,
  hash160,
  hexToBin,
  lockingBytecodeToCashAddress,
  sha256,
  utf8ToBin,
  type Output,
  type Transaction,
} from '@bitauth/libauth';
import type { SignTransactionRequest } from '@wizardconnect/core';
import { ensureUint8Array } from '../../utils/binary';
import { decodeWizardConnectTransaction } from './transaction';

export type SignInProofPathName = 'receive' | 'change' | 'defi';

export type SignInProofScheme = {
  /** Stable identifier. */
  id: string;
  /** What the user is signing in to, shown on the approval screen. */
  label: string;
  /** First OP_RETURN push. ASCII, 1-32 bytes. */
  opReturnTag: string;
  /** Prefix hashed with the code to derive the fake outpoint. */
  outpointTag: string;
  /** Value of the fake input, returned in full by output 1. */
  valueSatoshis: bigint;
  /** Accepted one-time code format. Anchored. */
  codePattern: RegExp;
};

/**
 * Badger Survivors editor sign-in, v0.545. Must stay byte-compatible with
 * shared/editor/challengeTx.js buildChallengeTx in LifestoneLabs/BadgerSurvivors.
 */
export const BADGER_SURVIVORS_EDITOR_SCHEME: SignInProofScheme = Object.freeze({
  id: 'badgersurvivors-editor',
  label: 'Badger Survivors editor',
  opReturnTag: 'BSEDITOR',
  outpointTag: 'BadgerSurvivors editor challenge:',
  valueSatoshis: 1000n,
  codePattern: /^[0-9a-f]{32}$/,
});

/**
 * Generic marker any dApp can adopt without a wallet release. The approval
 * screen labels it as a generic sign-in so the user relies on the dApp name.
 */
export const GENERIC_WIZARDCONNECT_SCHEME: SignInProofScheme = Object.freeze({
  id: 'wizardconnect-generic',
  label: 'WizardConnect sign-in',
  opReturnTag: 'WCPROOF',
  outpointTag: 'WizardConnect sign-in proof:',
  valueSatoshis: 1000n,
  codePattern: /^[0-9A-Za-z_-]{16,64}$/,
});

const schemes: SignInProofScheme[] = [
  BADGER_SURVIVORS_EDITOR_SCHEME,
  GENERIC_WIZARDCONNECT_SCHEME,
];

export function listSignInProofSchemes(): readonly SignInProofScheme[] {
  return schemes;
}

/** Add a scheme. Tags must be unique; an existing tag cannot be replaced. */
export function registerSignInProofScheme(scheme: SignInProofScheme): void {
  if (!/^[\x21-\x7e]{1,32}$/.test(scheme.opReturnTag)) {
    throw new Error('Sign-in proof tag must be 1-32 printable ASCII bytes');
  }
  if (
    !scheme.codePattern.source.startsWith('^') ||
    !scheme.codePattern.source.endsWith('$')
  ) {
    throw new Error('Sign-in proof code pattern must be anchored');
  }
  if (scheme.valueSatoshis <= 0n || scheme.valueSatoshis > 100_000n) {
    throw new Error('Sign-in proof value out of range');
  }
  if (
    schemes.some(
      (s) => s.opReturnTag === scheme.opReturnTag || s.id === scheme.id
    )
  ) {
    throw new Error(
      `Sign-in proof scheme already registered: ${scheme.opReturnTag}`
    );
  }
  schemes.push(Object.freeze({ ...scheme }));
}

/** Codes are pushed with a single-byte length prefix; keep them short. */
const MAX_CODE_BYTES = 64;
export const SIGN_IN_PROOF_SIGHASH = 0x61;

export class SignInProofError extends Error {
  constructor(message: string) {
    super(`WizardConnect sign-in proof refused: ${message}`);
    this.name = 'SignInProofError';
  }
}

type DecodedPush = { opcode: number; data?: Uint8Array };

function opReturnPushes(lockingBytecode: Uint8Array): Uint8Array[] | null {
  if (lockingBytecode.length === 0 || lockingBytecode[0] !== 0x6a) return null;
  const ops = decodeAuthenticationInstructions(
    lockingBytecode.slice(1)
  ) as DecodedPush[];
  const pushes: Uint8Array[] = [];
  for (const op of ops) {
    if (!op.data || 'malformed' in op) return null;
    pushes.push(op.data);
  }
  return pushes;
}

/**
 * The scheme whose tag appears as the first push of any OP_RETURN output, or
 * null when the transaction does not claim to be a sign-in proof.
 */
export function findClaimedSignInProofScheme(
  outputs: readonly { lockingBytecode: unknown }[]
): SignInProofScheme | null {
  let found: SignInProofScheme | null = null;
  for (const out of outputs) {
    let bytecode: Uint8Array;
    try {
      bytecode = ensureUint8Array(out.lockingBytecode);
    } catch {
      continue;
    }
    if (bytecode[0] !== 0x6a) continue;
    // Look at the raw first push too, so a malformed OP_RETURN with a tag
    // still counts as a claim (and is then refused).
    const firstPushLength = bytecode[1];
    if (
      firstPushLength === undefined ||
      firstPushLength < 1 ||
      firstPushLength > 75
    )
      continue;
    const tag = binToUtf8(bytecode.slice(2, 2 + firstPushLength));
    const scheme = schemes.find((s) => s.opReturnTag === tag);
    if (!scheme) continue;
    if (found && found !== scheme) {
      throw new SignInProofError('more than one sign-in tag');
    }
    found = scheme;
  }
  return found;
}

/**
 * Claimed scheme for a WizardConnect sign payload. The dApp may send the
 * transaction as an object or as raw hex (Badger Survivors sends hex).
 */
export function findClaimedSignInProofSchemeInPayload(
  payload:
    | Pick<SignTransactionRequest['transaction'], 'transaction'>
    | undefined
): SignInProofScheme | null {
  const raw = payload?.transaction as unknown;
  let outputs: unknown;
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!/^(?:[\da-fA-F]{2})+$/.test(text)) return null;
    const decoded = decodeTransaction(hexToBin(text));
    if (typeof decoded === 'string') return null;
    outputs = decoded.outputs;
  } else if (raw && typeof raw === 'object') {
    outputs = (raw as { outputs?: unknown }).outputs;
  }
  if (!Array.isArray(outputs)) return null;
  return findClaimedSignInProofScheme(
    outputs as { lockingBytecode: unknown }[]
  );
}

function pushData(bytes: Uint8Array): number[] {
  if (bytes.length < 1 || bytes.length > 75)
    throw new SignInProofError('push length');
  return [bytes.length, ...bytes];
}

export function signInProofOutpointHash(
  scheme: SignInProofScheme,
  code: string
): Uint8Array {
  return sha256.hash(utf8ToBin(`${scheme.outpointTag}${code}`));
}

export function signInProofOpReturn(
  scheme: SignInProofScheme,
  code: string
): Uint8Array {
  return Uint8Array.from([
    0x6a,
    ...pushData(utf8ToBin(scheme.opReturnTag)),
    ...pushData(utf8ToBin(code)),
  ]);
}

export function assertSignInProofCode(
  scheme: SignInProofScheme,
  code: string
): void {
  if (
    typeof code !== 'string' ||
    utf8ToBin(code).length > MAX_CODE_BYTES ||
    !scheme.codePattern.test(code)
  ) {
    throw new SignInProofError(`invalid one-time code for ${scheme.label}`);
  }
}

function isP2pkh(lockingBytecode: Uint8Array): boolean {
  return (
    lockingBytecode.length === 25 &&
    lockingBytecode[0] === 0x76 &&
    lockingBytecode[1] === 0xa9 &&
    lockingBytecode[2] === 0x14 &&
    lockingBytecode[23] === 0x88 &&
    lockingBytecode[24] === 0xac
  );
}

export function p2pkhLockingBytecode(publicKey: Uint8Array): Uint8Array {
  return Uint8Array.from([0x76, 0xa9, 0x14, ...hash160(publicKey), 0x88, 0xac]);
}

export type CanonicalSignInProof = {
  transaction: Transaction;
  sourceOutputs: (Output & {
    outpointTransactionHash: Uint8Array;
    outpointIndex: number;
    sequenceNumber: number;
    unlockingBytecode: Uint8Array;
  })[];
};

/**
 * Build the unsigned proof. The only inputs are the scheme, the code, and the
 * wallet's own P2PKH locking bytecode; nothing comes from the dApp's tx.
 */
export function buildCanonicalSignInProof(
  scheme: SignInProofScheme,
  code: string,
  lockingBytecode: Uint8Array
): CanonicalSignInProof {
  assertSignInProofCode(scheme, code);
  if (!isP2pkh(lockingBytecode)) {
    throw new SignInProofError('address is not P2PKH');
  }
  const input = {
    outpointTransactionHash: signInProofOutpointHash(scheme, code),
    outpointIndex: 0,
    sequenceNumber: 0xffffffff,
    unlockingBytecode: new Uint8Array(0),
  };
  return {
    transaction: {
      version: 2,
      locktime: 0,
      inputs: [{ ...input }],
      outputs: [
        {
          lockingBytecode: signInProofOpReturn(scheme, code),
          valueSatoshis: 0n,
        },
        {
          lockingBytecode: Uint8Array.from(lockingBytecode),
          valueSatoshis: scheme.valueSatoshis,
        },
      ],
    },
    sourceOutputs: [
      {
        ...input,
        lockingBytecode: Uint8Array.from(lockingBytecode),
        valueSatoshis: scheme.valueSatoshis,
      },
    ],
  };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

export type ValidatedSignInProof = {
  scheme: SignInProofScheme;
  code: string;
  path: SignInProofPathName;
  addressIndex: number;
  publicKey: Uint8Array;
  lockingBytecode: Uint8Array;
  proof: CanonicalSignInProof;
};

export type SignInProofKeyLookup = (
  path: SignInProofPathName,
  addressIndex: number
) => Uint8Array;

/**
 * The shared decoder spreads every field of a structured input over its
 * source output (so an input object can carry `valueSatoshis`). For a proof we
 * want to check exactly the source output the dapp sent, so structured inputs
 * are cut down to their transaction fields first.
 */
function stripInputMetadata(
  payload: SignTransactionRequest['transaction']
): SignTransactionRequest['transaction'] {
  const raw = payload.transaction as unknown;
  if (
    !raw ||
    typeof raw !== 'object' ||
    !Array.isArray((raw as Transaction).inputs)
  ) {
    return payload;
  }
  const tx = raw as Transaction;
  return {
    ...payload,
    transaction: {
      ...tx,
      inputs: tx.inputs.map((input) => ({
        outpointTransactionHash: input.outpointTransactionHash,
        outpointIndex: input.outpointIndex,
        sequenceNumber: input.sequenceNumber,
        unlockingBytecode: input.unlockingBytecode,
      })),
    },
  } as SignTransactionRequest['transaction'];
}

/**
 * Returns null when the request does not claim to be a sign-in proof.
 * Throws SignInProofError when it claims to be one but is not exactly the
 * canonical proof for one of this wallet's own P2PKH addresses.
 */
export function validateSignInProofRequest(
  request: Pick<SignTransactionRequest, 'transaction' | 'inputPaths'>,
  publicKeyFor: SignInProofKeyLookup
): ValidatedSignInProof | null {
  const scheme = findClaimedSignInProofSchemeInPayload(request.transaction);
  if (!scheme) return null;

  if (request.transaction.broadcast) {
    throw new SignInProofError('a sign-in proof is never broadcast');
  }

  let decoded: ReturnType<typeof decodeWizardConnectTransaction>;
  try {
    decoded = decodeWizardConnectTransaction(
      stripInputMetadata(request.transaction)
    );
  } catch (error) {
    throw new SignInProofError(
      error instanceof Error ? error.message : 'invalid transaction'
    );
  }
  const { transaction, sourceOutputs } = decoded;

  if (transaction.inputs.length !== 1 || sourceOutputs.length !== 1) {
    throw new SignInProofError('a proof has exactly one (fake) input');
  }
  if (transaction.outputs.length !== 2) {
    throw new SignInProofError('a proof has exactly two outputs');
  }

  const pushes = opReturnPushes(
    ensureUint8Array(transaction.outputs[0].lockingBytecode)
  );
  if (
    !pushes ||
    pushes.length !== 2 ||
    binToUtf8(pushes[0]) !== scheme.opReturnTag
  ) {
    throw new SignInProofError('output 0 must be OP_RETURN <tag> <code>');
  }
  const code = binToUtf8(pushes[1]);
  if (!sameBytes(utf8ToBin(code), pushes[1])) {
    throw new SignInProofError('code is not valid UTF-8');
  }
  assertSignInProofCode(scheme, code);

  const paths = request.inputPaths ?? [];
  if (paths.length !== 1 || paths[0][0] !== 0) {
    throw new SignInProofError('exactly one wallet input path, for input 0');
  }
  const [, path, addressIndex] = paths[0];
  if (!['receive', 'change', 'defi'].includes(path)) {
    throw new SignInProofError('unsupported address path');
  }
  if (
    !Number.isSafeInteger(addressIndex) ||
    addressIndex < 0 ||
    addressIndex >= 0x80000000
  ) {
    throw new SignInProofError('invalid address index');
  }

  // The address is derived from this wallet's own keys, never taken from the
  // dApp. The dApp's source output must already lock to it.
  const publicKey = publicKeyFor(path as SignInProofPathName, addressIndex);
  const lockingBytecode = p2pkhLockingBytecode(publicKey);
  const proof = buildCanonicalSignInProof(scheme, code, lockingBytecode);

  const expectedHash = signInProofOutpointHash(scheme, code);
  if (
    !sameBytes(
      proof.transaction.inputs[0].outpointTransactionHash,
      expectedHash
    )
  ) {
    throw new SignInProofError('outpoint is not the derived fake outpoint');
  }

  const source = sourceOutputs[0] as (typeof sourceOutputs)[number] & {
    outpointTransactionHash?: unknown;
    outpointIndex?: unknown;
    sequenceNumber?: unknown;
  };
  const canonicalSource = proof.sourceOutputs[0];
  if (
    source.token ||
    source.contract ||
    source.valueSatoshis !== canonicalSource.valueSatoshis ||
    !sameBytes(
      ensureUint8Array(source.lockingBytecode),
      canonicalSource.lockingBytecode
    ) ||
    (source.unlockingBytecode !== undefined &&
      ensureUint8Array(source.unlockingBytecode).length !== 0)
  ) {
    throw new SignInProofError(
      'source output is not the fake proof input for this address'
    );
  }
  if (
    source.outpointTransactionHash !== undefined &&
    !sameBytes(ensureUint8Array(source.outpointTransactionHash), expectedHash)
  ) {
    throw new SignInProofError('source output outpoint does not match');
  }

  for (const out of transaction.outputs) {
    if ((out as Output).token)
      throw new SignInProofError('token data is not allowed');
  }
  for (const input of transaction.inputs) {
    if (ensureUint8Array(input.unlockingBytecode).length !== 0) {
      throw new SignInProofError('input is already unlocked');
    }
  }

  const requested = encodeTransaction(transaction as Transaction);
  const canonical = encodeTransaction(proof.transaction);
  if (!sameBytes(requested, canonical)) {
    throw new SignInProofError('transaction differs from the canonical proof');
  }

  return {
    scheme,
    code,
    path: path as SignInProofPathName,
    addressIndex,
    publicKey,
    lockingBytecode,
    proof,
  };
}

export function signInProofAddress(
  proof: ValidatedSignInProof,
  prefix: string
): string {
  const result = lockingBytecodeToCashAddress({
    prefix: prefix as 'bitcoincash',
    bytecode: proof.lockingBytecode,
  });
  return typeof result === 'string' ? result : result.address;
}

/**
 * Sign the canonical proof (never the dApp's object) with the key for the
 * proven address. `signP2pkh` returns the P2PKH unlocking bytecode.
 */
export function signCanonicalSignInProof(
  validated: ValidatedSignInProof,
  signP2pkh: (
    context: {
      inputIndex: number;
      sourceOutputs: CanonicalSignInProof['sourceOutputs'];
      transaction: Transaction;
    },
    sighash: number
  ) => Uint8Array
): string {
  const { proof } = validated;
  const transaction: Transaction = {
    ...proof.transaction,
    inputs: proof.transaction.inputs.map((input) => ({ ...input })),
  };
  const unlocking = signP2pkh(
    {
      inputIndex: 0,
      sourceOutputs: proof.sourceOutputs,
      transaction: proof.transaction,
    },
    SIGN_IN_PROOF_SIGHASH
  );
  const ops = decodeAuthenticationInstructions(unlocking) as DecodedPush[];
  if (ops.length !== 2 || !ops[0].data || !ops[1].data) {
    throw new SignInProofError(
      'signer returned an unexpected unlocking script'
    );
  }
  const signature = ops[0].data;
  if (signature[signature.length - 1] !== SIGN_IN_PROOF_SIGHASH) {
    throw new SignInProofError('signer used the wrong sighash type');
  }
  if (!sameBytes(ops[1].data, validated.publicKey)) {
    throw new SignInProofError('signing key does not match the proven address');
  }
  transaction.inputs[0].unlockingBytecode = unlocking;
  const signed = encodeTransaction(transaction);
  if (!isSignInProofTransaction(signed)) {
    throw new SignInProofError('signed proof failed self-check');
  }
  return binToHex(signed);
}

/**
 * True when raw transaction bytes are a sign-in proof: a registered tag in an
 * OP_RETURN and an input spending that scheme's derived fake outpoint. Used to
 * stop a proof from ever being handed to a broadcast path.
 */
export function isSignInProofTransaction(raw: Uint8Array | string): boolean {
  let bytes: Uint8Array;
  try {
    bytes = typeof raw === 'string' ? hexToBin(raw.trim()) : raw;
  } catch {
    return false;
  }
  const tx = decodeTransaction(bytes);
  if (typeof tx === 'string') return false;
  let scheme: SignInProofScheme | null;
  try {
    scheme = findClaimedSignInProofScheme(tx.outputs);
  } catch {
    return true; // conflicting tags: treat as a proof, never broadcast
  }
  if (!scheme) return false;
  for (const out of tx.outputs) {
    const pushes = opReturnPushes(out.lockingBytecode);
    if (
      !pushes ||
      pushes.length < 2 ||
      binToUtf8(pushes[0]) !== scheme.opReturnTag
    )
      continue;
    const expected = signInProofOutpointHash(scheme, binToUtf8(pushes[1]));
    if (
      tx.inputs.some((input) =>
        sameBytes(input.outpointTransactionHash, expected)
      )
    ) {
      return true;
    }
  }
  return false;
}
