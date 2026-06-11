import type { UTXO } from '../types/types';

function isTokenUtxo(utxo: UTXO): boolean {
  return Boolean(utxo.token?.category);
}

export function dedupeTokenUtxos(utxos: UTXO[]): UTXO[] {
  const deduped = new Map<string, UTXO>();

  for (const utxo of utxos) {
    if (!isTokenUtxo(utxo)) continue;
    deduped.set(`${utxo.tx_hash}:${utxo.tx_pos}`, utxo);
  }

  return Array.from(deduped.values());
}

export function getStableTokenUtxos(...sources: UTXO[][]): UTXO[] {
  for (const source of sources) {
    const normalized = dedupeTokenUtxos(source);
    if (normalized.length > 0) return normalized;
  }

  return [];
}
