import { binToHex, sha256 } from '@bitauth/libauth';

export type PartiallySignedInput = {
  index: number;
  signerRole: 'wallet' | 'cosigner' | 'contract' | 'application';
  status: 'unsigned' | 'partial' | 'finalized';
  derivationPath?: string;
  partialSignatures: Array<{
    publicKey: string;
    signature: string;
  }>;
  unlockingBytecode?: Uint8Array;
};

export type PartiallySignedTransaction = {
  version: 1;
  network: 'mainnet' | 'chipnet' | 'mocknet';
  unsignedTransaction: unknown;
  sourceOutputs: unknown[];
  inputs: PartiallySignedInput[];
  application?: {
    applicationId: string;
    contractName?: string;
    functionName?: string;
    metadata?: Record<string, unknown>;
  };
  metadata: {
    requestId: string;
    purpose: string;
    createdAt: number;
    expiresAt?: number;
    transactionFingerprint: string;
  };
};

export type TransactionSigningResponse = {
  version: 1;
  requestId: string;
  transactionFingerprint: string;
  approved: boolean;
  signerLabel: string;
  signatures: Array<{
    inputIndex: number;
    publicKey: string;
    signature: string;
  }>;
};

const BYTES_MARKER = '__partially_signed_transaction_bytes__';
const BIGINT_MARKER = '__partially_signed_transaction_bigint__';
const MAX_SERIALIZED_BYTES = 2 * 1024 * 1024;

function toWireValue(value: unknown): unknown {
  if (typeof value === 'bigint') return { [BIGINT_MARKER]: value.toString() };
  if (value instanceof Uint8Array) {
    let binary = '';
    for (const byte of value) binary += String.fromCharCode(byte);
    return { [BYTES_MARKER]: btoa(binary) };
  }
  if (Array.isArray(value)) return value.map(toWireValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, toWireValue(entry)])
    );
  }
  return value;
}

function fromWireValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(fromWireValue);
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  if (typeof record[BYTES_MARKER] === 'string') {
    const binary = atob(record[BYTES_MARKER]);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }
  if (typeof record[BIGINT_MARKER] === 'string') return BigInt(record[BIGINT_MARKER]);
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [key, fromWireValue(entry)])
  );
}

function textBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function textFromBytes(value: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(value);
}

function assertPartiallySignedTransaction(value: unknown): asserts value is PartiallySignedTransaction {
  if (!value || typeof value !== 'object') throw new Error('Signing request is not an object');
  const transaction = value as Partial<PartiallySignedTransaction>;
  if (transaction.version !== 1) throw new Error('Unsupported signing request version');
  if (
    transaction.network !== 'mainnet' &&
    transaction.network !== 'chipnet' &&
    transaction.network !== 'mocknet'
  ) {
    throw new Error('Signing request has an invalid network');
  }
  if (!Array.isArray(transaction.sourceOutputs) || !Array.isArray(transaction.inputs)) {
    throw new Error('Signing request is missing input metadata');
  }
  if (!transaction.metadata || typeof transaction.metadata !== 'object') {
    throw new Error('Signing request is missing metadata');
  }
  if (typeof transaction.metadata.requestId !== 'string' || !transaction.metadata.requestId) {
    throw new Error('Signing request is missing its request ID');
  }
  if (typeof transaction.metadata.transactionFingerprint !== 'string') {
    throw new Error('Signing request is missing its fingerprint');
  }
}

export function serializePartiallySignedTransaction(
  transaction: PartiallySignedTransaction
): Uint8Array {
  assertPartiallySignedTransaction(transaction);
  const bytes = textBytes(JSON.stringify(toWireValue(transaction)));
  if (bytes.length > MAX_SERIALIZED_BYTES) throw new Error('Signing request is too large');
  return bytes;
}

export function deserializePartiallySignedTransaction(
  bytes: Uint8Array
): PartiallySignedTransaction {
  if (bytes.length === 0 || bytes.length > MAX_SERIALIZED_BYTES) {
    throw new Error('Signing request has an invalid size');
  }
  let parsed: unknown;
  try {
    parsed = fromWireValue(JSON.parse(textFromBytes(bytes)));
  } catch {
    throw new Error('Signing request is not valid JSON');
  }
  assertPartiallySignedTransaction(parsed);
  return parsed;
}

export function createTransactionFingerprint(transaction: Omit<PartiallySignedTransaction, 'metadata'>): string {
  const bytes = textBytes(JSON.stringify(toWireValue(transaction)));
  return binToHex(sha256.hash(bytes));
}

export function createSigningResponse(params: {
  request: PartiallySignedTransaction;
  signerLabel: string;
  approved: boolean;
  publicKey?: string;
  signature?: string;
  inputIndex?: number;
}): TransactionSigningResponse {
  const signatures =
    params.approved && params.publicKey && params.signature && params.inputIndex !== undefined
      ? [{ inputIndex: params.inputIndex, publicKey: params.publicKey, signature: params.signature }]
      : [];
  return {
    version: 1,
    requestId: params.request.metadata.requestId,
    transactionFingerprint: params.request.metadata.transactionFingerprint,
    approved: params.approved,
    signerLabel: params.signerLabel,
    signatures,
  };
}

export function serializeTransactionSigningResponse(response: TransactionSigningResponse): Uint8Array {
  return textBytes(JSON.stringify(toWireValue(response)));
}

export function deserializeTransactionSigningResponse(bytes: Uint8Array): TransactionSigningResponse {
  if (bytes.length === 0 || bytes.length > MAX_SERIALIZED_BYTES) {
    throw new Error('Signing response has an invalid size');
  }
  let parsed: unknown;
  try {
    parsed = fromWireValue(JSON.parse(textFromBytes(bytes)));
  } catch {
    throw new Error('Signing response is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || (parsed as TransactionSigningResponse).version !== 1) {
    throw new Error('Unsupported signing response');
  }
  return parsed as TransactionSigningResponse;
}
