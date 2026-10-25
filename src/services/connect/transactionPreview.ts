import { ensureUint8Array, parseSatoshis } from '../../utils/binary';

const MAX_SATS = 21_000_000n * 100_000_000n;

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Transaction request is incomplete');
  }
  return value as RecordValue;
}

function bytes(value: unknown, length?: number): Uint8Array {
  const validShape =
    value instanceof Uint8Array ||
    (typeof value === 'string' &&
      /^(?:[\da-fA-F]{2})*$|^<Uint8Array: 0x(?:[\da-fA-F]{2})*>$/.test(
        value
      )) ||
    (Array.isArray(value) &&
      value.every(
        (byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255
      ));
  if (!validShape) throw new Error('Transaction request has invalid bytecode');
  const result = ensureUint8Array(value);
  if (length !== undefined && result.length !== length) {
    throw new Error('Transaction request has invalid bytecode length');
  }
  return result;
}

function sats(value: unknown, maximum = MAX_SATS): bigint {
  if (
    !(
      typeof value === 'bigint' ||
      (typeof value === 'number' && Number.isSafeInteger(value)) ||
      (typeof value === 'string' && /^(?:\d+|<bigint: \d+n>)$/.test(value))
    )
  ) {
    throw new Error('Transaction request has invalid value');
  }
  const amount = parseSatoshis(value);
  if (amount < 0n || amount > maximum) {
    throw new Error('Transaction request has an out-of-range value');
  }
  return amount;
}

function uint32(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 0xffffffff
  ) {
    throw new Error('Transaction request has an invalid input index');
  }
  return value;
}

export type ConnectorPreviewToken = {
  category: Uint8Array;
  amount: bigint;
  nft?: { capability: 'none' | 'mutable' | 'minting'; commitment: Uint8Array };
};

export type ConnectorPreviewOutput = {
  valueSatoshis: bigint;
  lockingBytecode: Uint8Array;
  token?: ConnectorPreviewToken;
};

export type ConnectorTransactionPreview = {
  inputs: Array<{
    outpointTransactionHash: Uint8Array;
    outpointIndex: number;
    valueSatoshis: bigint;
    lockingBytecode: Uint8Array;
    token?: ConnectorPreviewToken;
  }>;
  outputs: ConnectorPreviewOutput[];
  totalInput: bigint;
  totalOutput: bigint;
  fee: bigint;
};

function output(value: unknown): ConnectorPreviewOutput {
  const raw = record(value);
  const parsed: ConnectorPreviewOutput = {
    valueSatoshis: sats(raw.valueSatoshis),
    lockingBytecode: bytes(raw.lockingBytecode),
  };
  if (raw.token !== undefined && raw.token !== null) {
    const token = record(raw.token);
    const category = bytes(token.category, 32);
    const amount = sats(token.amount, 0x7fffffffffffffffn);
    const nft = token.nft == null ? undefined : record(token.nft);
    if (
      nft &&
      !['none', 'mutable', 'minting'].includes(String(nft.capability))
    ) {
      throw new Error('Transaction request has an invalid NFT capability');
    }
    parsed.token = {
      category,
      amount,
      ...(nft
        ? {
            nft: {
              capability: nft.capability as 'none' | 'mutable' | 'minting',
              commitment: bytes(nft.commitment),
            },
          }
        : {}),
    };
  }
  return parsed;
}

/** Validates the exact transaction/source pair before presenting or signing it. */
export function transactionPreview(
  transaction: unknown,
  sourceOutputs: unknown
): ConnectorTransactionPreview {
  const tx = record(transaction);
  if (
    !Array.isArray(tx.inputs) ||
    tx.inputs.length === 0 ||
    !Array.isArray(tx.outputs) ||
    tx.outputs.length === 0 ||
    !Array.isArray(sourceOutputs) ||
    sourceOutputs.length !== tx.inputs.length
  ) {
    throw new Error(
      'Transaction request is missing inputs, outputs, or sources'
    );
  }
  uint32(tx.version);
  uint32(tx.locktime);
  const inputs = tx.inputs.map((value, index) => {
    const input = record(value);
    const source = output(sourceOutputs[index]);
    uint32(input.sequenceNumber);
    bytes(input.unlockingBytecode);
    return {
      outpointTransactionHash: bytes(input.outpointTransactionHash, 32),
      outpointIndex: uint32(input.outpointIndex),
      valueSatoshis: source.valueSatoshis,
      lockingBytecode: source.lockingBytecode,
      token: source.token,
    };
  });
  const outputs = tx.outputs.map(output);
  const totalInput = inputs.reduce(
    (sum, input) => sum + input.valueSatoshis,
    0n
  );
  const totalOutput = outputs.reduce(
    (sum, item) => sum + item.valueSatoshis,
    0n
  );
  if (totalInput > MAX_SATS || totalOutput > totalInput) {
    throw new Error('Transaction request has invalid totals');
  }
  return {
    inputs,
    outputs,
    totalInput,
    totalOutput,
    fee: totalInput - totalOutput,
  };
}
