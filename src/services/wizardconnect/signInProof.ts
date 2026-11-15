/**
 * WizardConnect sign-in proofs. Platform glue only.
 *
 * WizardConnect (hdwalletv1) has no message signing, only sign_transaction.
 * A dApp proves a wallet controls an address by asking it to sign a
 * transaction that can never be mined. The format, the validation, the
 * signing and the broadcast guard live in
 * crates/optn-core/src/sign_in_proof.rs, where every surface shares them.
 *
 * This file reshapes the SDK's request into what that core takes and carries
 * its answer (code, path, address index, address, or a refusal reason) back
 * to the wallet. It decides nothing about what a proof is.
 */
import {
  binToHex,
  decodeTransaction,
  encodeTransaction,
  hexToBin,
  type Transaction,
} from '@bitauth/libauth';
import type { SignTransactionRequest } from '@wizardconnect/core';
import type { Network } from '../../state/slices/networkSlice';
import { ensureUint8Array } from '../../utils/binary';
import {
  ensureOptnCore,
  isSignInProofTransaction as coreIsSignInProofTransaction,
  signInProofClaims,
  signInProofSign,
  signInProofValidate,
} from '../../wasm/optn-core';
import { decodeWizardConnectTransaction } from './transaction';

export type SignInProofPathName = 'receive' | 'change' | 'defi';

/** How the one proof format is named on the approval screen. */
export const WIZARDCONNECT_SIGN_IN_SCHEME = Object.freeze({
  id: 'wizardconnect-generic',
  label: 'WizardConnect sign-in',
});

export type SignInProofScheme = typeof WIZARDCONNECT_SIGN_IN_SCHEME;

export class SignInProofError extends Error {
  constructor(message: string) {
    super(`WizardConnect sign-in proof refused: ${message}`);
    this.name = 'SignInProofError';
  }
}

/** Call the core, turning whatever stops it into a refusal. */
function refusable<T>(call: () => T): T {
  try {
    ensureOptnCore();
    return call();
  } catch (error) {
    if (error instanceof SignInProofError) throw error;
    throw new SignInProofError(
      error instanceof Error ? error.message : String(error)
    );
  }
}

/**
 * The scheme if any output claims to be a sign-in proof, or null when the
 * transaction does not claim to be one. The core judges each output.
 */
export function findClaimedSignInProofScheme(
  outputs: readonly { lockingBytecode: unknown }[]
): SignInProofScheme | null {
  ensureOptnCore();
  for (const out of outputs) {
    let bytecode: Uint8Array;
    try {
      bytecode = ensureUint8Array(out.lockingBytecode);
    } catch {
      continue;
    }
    if (signInProofClaims(bytecode)) return WIZARDCONNECT_SIGN_IN_SCHEME;
  }
  return null;
}

/**
 * Claimed scheme for a WizardConnect sign payload. The dApp may send the
 * transaction as an object or as raw hex. Hex is read with the decoder the
 * payment signers use, so nothing they would sign can dodge the question.
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

/**
 * The shared decoder spreads every field of a structured input over its
 * source output (so an input object can carry `valueSatoshis`). The core must
 * be shown exactly the source output the dApp sent, so structured inputs are
 * cut down to their transaction fields first.
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
 * The request as the core takes it: the transaction as wire bytes (the dApp's
 * own bytes when it sent hex) and each source output reduced to what a proof
 * constrains. Throws when the SDK values cannot be decoded at all.
 */
function coreRequest(
  request: Pick<SignTransactionRequest, 'transaction' | 'inputPaths'>
): string {
  const { transaction, sourceOutputs } = decodeWizardConnectTransaction(
    stripInputMetadata(request.transaction)
  );
  const raw = request.transaction.transaction as unknown;
  return JSON.stringify({
    transaction:
      typeof raw === 'string' ? raw : binToHex(encodeTransaction(transaction)),
    sourceOutputs: sourceOutputs.map((source) => ({
      valueSatoshis: source.valueSatoshis.toString(),
      lockingBytecode: binToHex(ensureUint8Array(source.lockingBytecode)),
      token: Boolean(source.token),
      contract: Boolean(source.contract),
      unlockingBytecode: binToHex(ensureUint8Array(source.unlockingBytecode)),
    })),
    inputPaths: request.inputPaths ?? [],
    broadcast: Boolean(request.transaction.broadcast),
  });
}

/** What the core derives the proven address from: this wallet's own xpubs. */
export type SignInProofWallet = {
  network: Network;
  xpubs: Record<SignInProofPathName, string>;
};

/** A request the core accepted: the canonical proof for one of our addresses. */
export type ValidatedSignInProof = {
  scheme: SignInProofScheme;
  code: string;
  path: SignInProofPathName;
  addressIndex: number;
  address: string;
  publicKey: Uint8Array;
};

/**
 * Returns null when the request does not claim to be a sign-in proof.
 * Throws SignInProofError, carrying the core's reason, when it claims to be
 * one but is not exactly the canonical proof for one of this wallet's own
 * P2PKH addresses.
 */
export function validateSignInProofRequest(
  request: Pick<SignTransactionRequest, 'transaction' | 'inputPaths'>,
  wallet: SignInProofWallet
): ValidatedSignInProof | null {
  const scheme = findClaimedSignInProofSchemeInPayload(request.transaction);
  if (!scheme) return null;
  const proof = refusable(
    () =>
      JSON.parse(
        signInProofValidate(
          coreRequest(request),
          wallet.xpubs.receive,
          wallet.xpubs.change,
          wallet.xpubs.defi,
          wallet.network
        )
      ) as {
        code: string;
        path: SignInProofPathName;
        addressIndex: number;
        address: string;
        publicKey: string;
      }
  );
  return {
    scheme,
    code: proof.code,
    path: proof.path,
    addressIndex: proof.addressIndex,
    address: proof.address,
    publicKey: hexToBin(proof.publicKey),
  };
}

/**
 * Have the core build and sign the canonical proof for a validated request
 * with the key of the proven address. The dApp's transaction is never signed.
 * The core takes and erases its copy of the key; the caller wipes its own.
 */
export function signCanonicalSignInProof(
  validated: ValidatedSignInProof,
  privateKey: Uint8Array
): string {
  return binToHex(
    refusable(() =>
      signInProofSign(validated.code, validated.publicKey, privateKey)
    )
  );
}

/**
 * True when raw transaction bytes are a sign-in proof. Used to stop a proof
 * from ever being handed to a broadcast path.
 */
export function isSignInProofTransaction(raw: Uint8Array | string): boolean {
  let bytes: Uint8Array;
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!/^(?:[\da-fA-F]{2})+$/.test(text)) return false;
    bytes = hexToBin(text);
  } else {
    bytes = raw;
  }
  ensureOptnCore();
  return coreIsSignInProofTransaction(bytes);
}
