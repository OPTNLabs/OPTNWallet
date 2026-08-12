// src/pages/apps/mintCashTokensPoCApp/utils/selectGenesisUtxos.ts

import type { UTXO } from '../../../../types/types';

/**
 * Genesis candidates:
 * - MUST be vout=0 (tx_pos === 0)
 * - MUST NOT already contain token data (no utxo.token)
 *
 * Each unique candidate tx_hash can define a unique CashTokens category (genesis).
 */
export function selectGenesisUtxos(allUtxos: UTXO[]): UTXO[] {
  if (!Array.isArray(allUtxos)) return [];

  return (
    allUtxos
      .filter((u) => u && u.tx_pos === 0 && !u.token)
      // Optional: stable preference (largest first) to reduce fee/change risk
      .sort((a, b) => {
        const av = typeof a.value === 'bigint' ? a.value : BigInt(a.value ?? 0);
        const bv = typeof b.value === 'bigint' ? b.value : BigInt(b.value ?? 0);
        return bv > av ? 1 : bv < av ? -1 : 0;
      })
  );
}
