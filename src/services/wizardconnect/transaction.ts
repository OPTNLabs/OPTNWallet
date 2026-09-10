import {
  decodeTransaction,
  hexToBin,
  type Input,
  type Output,
  type Transaction,
} from '@bitauth/libauth';
import type { SignTransactionRequest } from '@wizardconnect/core';
import { ensureUint8Array, parseSatoshis } from '../../utils/binary';

type SourceOutput =
  SignTransactionRequest['transaction']['sourceOutputs'][number];
type OutputWithMetadata = Output &
  Partial<Input> &
  Pick<SourceOutput, 'contract'>;
const maxSatoshis = 21000000n * 100000000n;

// The pinned SDK predates Riften's relay deserialization helpers. Validate before
// using our permissive binary helpers: invalid wire values must never become zero.
function bytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (
    typeof value === 'string' &&
    /^(?:[\da-fA-F]{2})*$|^<Uint8Array: 0x(?:[\da-fA-F]{2})*>$/.test(value)
  ) {
    return ensureUint8Array(value);
  }
  throw new Error('WizardConnect: invalid transaction bytecode');
}

function amount(value: unknown, maximum: bigint): bigint {
  if (
    !(
      typeof value === 'bigint' ||
      (typeof value === 'number' && Number.isSafeInteger(value)) ||
      (typeof value === 'string' && /^(?:\d+|<bigint: \d+n>)$/.test(value))
    )
  ) {
    throw new Error('WizardConnect: invalid transaction amount');
  }
  const result = parseSatoshis(value);
  if (result < 0n || result > maximum)
    throw new Error('WizardConnect: transaction amount out of range');
  return result;
}

function uint32(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error('WizardConnect: invalid transaction integer');
  }
  return value;
}

function output(value: OutputWithMetadata): OutputWithMetadata {
  const normalized: OutputWithMetadata = {
    ...value,
    valueSatoshis: amount(value.valueSatoshis, maxSatoshis),
    lockingBytecode: bytes(value.lockingBytecode),
  };
  if (value.unlockingBytecode !== undefined)
    normalized.unlockingBytecode = bytes(value.unlockingBytecode);
  if (value.contract)
    normalized.contract = {
      ...value.contract,
      redeemScript: bytes(value.contract.redeemScript),
    };
  if (value.token) {
    const category = bytes(value.token.category);
    if (category.length !== 32)
      throw new Error('WizardConnect: invalid token category');
    const nft = value.token.nft;
    if (nft && !['none', 'mutable', 'minting'].includes(nft.capability)) {
      throw new Error('WizardConnect: invalid NFT capability');
    }
    normalized.token = {
      category,
      amount: amount(value.token.amount, 0x7fffffffffffffffn),
      ...(nft ? { nft: { ...nft, commitment: bytes(nft.commitment) } } : {}),
    };
  }
  return normalized;
}

/** Decode once at each boundary so approval and every signer see identical data. */
export function decodeWizardConnectTransaction(
  payload: SignTransactionRequest['transaction']
): {
  transaction: Transaction;
  sourceOutputs: SourceOutput[];
} {
  const raw = payload.transaction;
  const decoded =
    typeof raw === 'string'
      ? /^(?:[\da-fA-F]{2})+$/.test(raw)
        ? decodeTransaction(hexToBin(raw))
        : null
      : raw;
  if (
    !decoded ||
    typeof decoded === 'string' ||
    !Array.isArray(decoded.inputs) ||
    !Array.isArray(decoded.outputs) ||
    decoded.inputs.length === 0 ||
    decoded.outputs.length === 0 ||
    !Array.isArray(payload.sourceOutputs) ||
    payload.sourceOutputs.length !== decoded.inputs.length
  ) {
    throw new Error('WizardConnect: invalid transaction or source outputs');
  }
  const transaction: Transaction = {
    version: uint32(decoded.version),
    locktime: uint32(decoded.locktime),
    inputs: decoded.inputs.map((input) => {
      const hash = bytes(input.outpointTransactionHash);
      if (hash.length !== 32)
        throw new Error('WizardConnect: invalid outpoint hash');
      return {
        ...input,
        outpointTransactionHash: hash,
        outpointIndex: uint32(input.outpointIndex),
        sequenceNumber: uint32(input.sequenceNumber),
        unlockingBytecode: bytes(input.unlockingBytecode),
      };
    }),
    outputs: decoded.outputs.map(output),
  };
  const sourceOutputs = payload.sourceOutputs.map((value, index) => {
    const normalized = output(value);
    const input = transaction.inputs[index];
    return {
      ...normalized,
      ...input,
      unlockingBytecode:
        normalized.unlockingBytecode ?? input.unlockingBytecode,
    };
  });
  const totalInput = sourceOutputs.reduce(
    (sum, item) => sum + item.valueSatoshis,
    0n
  );
  const totalOutput = transaction.outputs.reduce(
    (sum, item) => sum + item.valueSatoshis,
    0n
  );
  if (totalInput > maxSatoshis || totalOutput > totalInput) {
    throw new Error('WizardConnect: invalid transaction totals');
  }
  return { transaction, sourceOutputs };
}
