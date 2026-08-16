import { TransactionOutput } from '../../types/types';

export type FeePreferences = {
  feeMode?: 'auto' | 'custom';
  customFeeSatPerByte?: number;
};

// A small buffer over the usual 1 sat/byte floor prevents otherwise-valid
// transactions from being rejected when a backend's rolling mempool minimum
// rises slightly above its configured relay floor.
const RELAY_FEE_MILLISATS_PER_BYTE = 1_100n;

export function relayFeeForBytes(bytes: number): bigint {
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new Error('Transaction byte size must be a non-negative safe integer.');
  }
  return (BigInt(bytes) * RELAY_FEE_MILLISATS_PER_BYTE + 999n) / 1_000n;
}

export function requiredFeeForBytes(
  bytes: number,
  preferences: FeePreferences = {}
): bigint {
  const minimum = relayFeeForBytes(bytes);
  if (preferences.feeMode !== 'custom') return minimum;

  const rate = Number(preferences.customFeeSatPerByte);
  if (!Number.isFinite(rate) || rate <= 0) return minimum;

  const custom = BigInt(Math.ceil(rate * bytes));
  return custom > minimum ? custom : minimum;
}

/**
 * Upper-bound size for a standard BCH transaction with P2PKH inputs and one
 * or more standard cash-address outputs. The 149-byte input bound covers a
 * maximum-length DER signature; 44 bytes covers the largest standard P2SH32
 * output. Max uses this bound so its preview cannot overstate spendable funds.
 */
export function estimateMaxStandardTransactionBytes(
  inputCount: number,
  outputCount: number
): number {
  if (
    !Number.isSafeInteger(inputCount) ||
    inputCount < 0 ||
    !Number.isSafeInteger(outputCount) ||
    outputCount < 0
  ) {
    throw new Error(
      'Transaction input/output counts must be non-negative integers.'
    );
  }

  const varintSize = (count: number) =>
    count < 0xfd ? 1 : count <= 0xffff ? 3 : count <= 0xffffffff ? 5 : 9;

  return (
    4 +
    varintSize(inputCount) +
    inputCount * 149 +
    varintSize(outputCount) +
    outputCount * 44 +
    4
  );
}

export function estimateAddP2PKHOutputBytes(
  baseTxBytes: number,
  currentOutputsCount: number
): number {
  const outputBytes = 34;
  const varintSize = (n: number) =>
    n < 0xfd ? 1 : n <= 0xffff ? 3 : n <= 0xffffffff ? 5 : 9;
  const before = varintSize(currentOutputsCount);
  const after = varintSize(currentOutputsCount + 1);

  return baseTxBytes + outputBytes + (after - before);
}

export function txBytesFromHex(hex: string): number {
  return Math.floor(hex.length / 2);
}

export function hasExplicitManualChangeOutput(
  outputs: TransactionOutput[],
  changeAddress: string
): boolean {
  if (!changeAddress) return false;
  return outputs.some((output) => {
    if ('opReturn' in output && output.opReturn !== undefined) return false;
    return (output as { _manualChange?: boolean })._manualChange === true;
  });
}

export function formatMinRelayError(params: {
  paying: bigint;
  size: number;
  needAtLeast: number;
  shortBy: number;
  tip?: string;
}): string {
  const { paying, size, needAtLeast, shortBy, tip } = params;
  return [
    'Min relay fee not met under the wallet relay-margin policy.',
    `paying=${paying.toString()} sats`,
    `size=${size} bytes`,
    `need_at_least=${needAtLeast} sats`,
    `short_by=${shortBy} sats`,
    tip
      ? tip
      : 'Tip: remove/reduce any manual "change back to yourself" output and let Change Address auto-add change.',
  ].join(' ');
}
