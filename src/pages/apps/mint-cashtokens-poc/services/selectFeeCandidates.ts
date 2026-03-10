import type { MintAppUtxo } from '../types';
import { utxoKey, utxoValue } from '../utils';

export function selectFeeCandidates(
  utxos: MintAppUtxo[],
  excludedKeys?: ReadonlySet<string>
): MintAppUtxo[] {
  const out: MintAppUtxo[] = [];
  for (const u of utxos) {
    if (u.token || u.tx_pos === 0) continue;
    if (excludedKeys && excludedKeys.has(utxoKey(u))) continue;
    out.push(u);
  }

  return out.sort((a, b) => {
      const aVal = utxoValue(a);
      const bVal = utxoValue(b);
      if (bVal > aVal) return 1;
      if (bVal < aVal) return -1;
      return 0;
    });
}
