import { SATSINBITCOIN } from '../../utils/constants';
import { UTXO } from '../../types/types';

export function validateRecipient(addr: string) {
  return typeof addr === 'string' && addr.trim().length > 10;
}

export function parseAmountToSats(val: string): number {
  const n = Number(val);
  if (!isFinite(n) || n <= 0) return 0;
  return Math.round(n * SATSINBITCOIN);
}

export function isConfirmed(u: UTXO) {
  return typeof u.height === 'number' && u.height > 0;
}

export function sortLargestFirst(pool: UTXO[]) {
  return [...pool].sort((a, b) =>
    Number(BigInt(b.amount ?? b.value) - BigInt(a.amount ?? a.value))
  );
}

export function sumInputsSats(inputs: UTXO[]) {
  return inputs.reduce((s, u) => s + Number(u.amount ?? u.value ?? 0), 0);
}
