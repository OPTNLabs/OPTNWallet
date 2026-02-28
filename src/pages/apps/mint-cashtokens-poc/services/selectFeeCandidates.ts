import type { MintAppUtxo } from '../types';
import { utxoKey, utxoValue } from '../utils';

export function selectFeeCandidates(
  utxos: MintAppUtxo[],
  excludedKeys?: ReadonlySet<string>
): MintAppUtxo[] {
  return utxos
    .filter((u) => !u.token && u.tx_pos !== 0)
    .filter((u) => (excludedKeys ? !excludedKeys.has(utxoKey(u)) : true))
    .sort((a, b) => {
      const aVal = utxoValue(a);
      const bVal = utxoValue(b);
      if (bVal > aVal) return 1;
      if (bVal < aVal) return -1;
      return 0;
    });
}
