import type { UTXO } from '../types/types';

export type QuantumrootVaultStatus = {
  receiveBalanceSats: number;
  receiveUtxoCount: number;
  quantumLockBalanceSats: number;
  quantumLockUtxoCount: number;
  totalBalanceSats: number;
  totalUtxoCount: number;
  isFunded: boolean;
};

export type QuantumrootReceiveUtxoBuckets = {
  recoverableReceiveUtxos: UTXO[];
  unsupportedReceiveUtxos: UTXO[];
};

const DUST_LIMIT_SATS = 546;

function sumUtxoValues(utxos: UTXO[]): number {
  return utxos.reduce((total, utxo) => total + (utxo.value ?? utxo.amount ?? 0), 0);
}

export function bucketQuantumrootReceiveUtxos(
  receiveUtxos: UTXO[]
): QuantumrootReceiveUtxoBuckets {
  return {
    recoverableReceiveUtxos: receiveUtxos.filter(
      (utxo) => !utxo.token && (utxo.value ?? utxo.amount ?? 0) > DUST_LIMIT_SATS
    ),
    unsupportedReceiveUtxos: receiveUtxos.filter((utxo) => !!utxo.token),
  };
}

export function summarizeQuantumrootVaultStatus(
  receiveUtxos: UTXO[],
  quantumLockUtxos: UTXO[]
): QuantumrootVaultStatus {
  const receiveBalanceSats = sumUtxoValues(receiveUtxos);
  const quantumLockBalanceSats = sumUtxoValues(quantumLockUtxos);
  const totalBalanceSats = receiveBalanceSats + quantumLockBalanceSats;
  const totalUtxoCount = receiveUtxos.length + quantumLockUtxos.length;

  return {
    receiveBalanceSats,
    receiveUtxoCount: receiveUtxos.length,
    quantumLockBalanceSats,
    quantumLockUtxoCount: quantumLockUtxos.length,
    totalBalanceSats,
    totalUtxoCount,
    isFunded: totalBalanceSats > 0,
  };
}
