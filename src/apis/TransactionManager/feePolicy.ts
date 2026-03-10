import { TransactionOutput } from '../../types/types';

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
    'Min relay fee not met under 1 sat/byte policy.',
    `paying=${paying.toString()} sats`,
    `size=${size} bytes`,
    `need_at_least=${needAtLeast} sats`,
    `short_by=${shortBy} sats`,
    tip
      ? tip
      : 'Tip: remove/reduce any manual "change back to yourself" output and let Change Address auto-add change.',
  ].join(' ');
}
