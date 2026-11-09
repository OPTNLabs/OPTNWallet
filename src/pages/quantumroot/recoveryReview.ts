import type { UTXO } from '../../types/types';

export type QuantumrootRecoveryReviewKind =
  | 'spend'
  | 'sweep'
  | 'quantum-lock'
  | 'authorized';

export type QuantumrootRecoveryReview = {
  kind: QuantumrootRecoveryReviewKind;
  destinationAddress: string;
  sweptUtxos: UTXO[];
  inputSats: bigint;
  feeSats: bigint;
  recoveryAmountSats: bigint;
  reservedOutputSats: bigint;
  rawTransaction: string;
  transactionByteLength: number;
};

function satoshisOf(utxo: UTXO): bigint {
  const value = utxo.value ?? utxo.amount ?? 0;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(Math.trunc(value));
  try {
    return BigInt(value);
  } catch {
    throw new Error('Quantumroot recovery input has an invalid BCH value.');
  }
}

export function createQuantumrootRecoveryReview(args: {
  kind: QuantumrootRecoveryReviewKind;
  destinationAddress: string;
  sweptUtxos: UTXO[];
  feeSats: bigint;
  recoveryAmountSats: bigint;
  reservedOutputSats?: bigint;
  rawTransaction: string;
  transactionByteLength: number;
}): QuantumrootRecoveryReview {
  const destinationAddress = args.destinationAddress.trim();
  if (!destinationAddress) {
    throw new Error('Quantumroot recovery requires a destination address.');
  }
  if (!args.sweptUtxos.length) {
    throw new Error('Quantumroot recovery requires at least one input.');
  }
  const reservedOutputSats = args.reservedOutputSats ?? 0n;
  if (
    args.feeSats < 0n ||
    args.recoveryAmountSats <= 0n ||
    reservedOutputSats < 0n
  ) {
    throw new Error('Quantumroot recovery amounts are invalid.');
  }
  if (!args.rawTransaction || args.transactionByteLength <= 0) {
    throw new Error('Quantumroot recovery transaction is incomplete.');
  }

  const inputSats = args.sweptUtxos.reduce(
    (sum, utxo) => sum + satoshisOf(utxo),
    0n
  );
  if (
    inputSats !==
    args.feeSats + args.recoveryAmountSats + reservedOutputSats
  ) {
    throw new Error('Quantumroot recovery totals could not be verified.');
  }

  return {
    kind: args.kind,
    destinationAddress,
    sweptUtxos: args.sweptUtxos,
    inputSats,
    feeSats: args.feeSats,
    recoveryAmountSats: args.recoveryAmountSats,
    reservedOutputSats,
    rawTransaction: args.rawTransaction,
    transactionByteLength: args.transactionByteLength,
  };
}
