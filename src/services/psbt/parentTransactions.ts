// Fetch the parent transactions a watch-only PSBT has to carry.
//
// PSBT_IN_NON_WITNESS_UTXO holds the whole transaction an input spends, and
// that is the field the offline signers actually read: Paytaca writes it, and
// SeedCash's compact WITNESS_UTXO path mis-slices the script it signs over
// (see psbtBch.ts). So a proposal cannot be built from UTXO rows alone — each
// selected coin needs its parent pulled from Electrum first.
//
// Only the selected coins are fetched, at build time rather than at wallet
// load: a wallet with hundreds of coins would otherwise pay for parents it
// never spends. Results are cached for the session because a parent
// transaction is immutable once mined.

import ElectrumServer from '../../apis/ElectrumServer/ElectrumServer';

export const MAX_PARENT_TRANSACTION_CACHE_ENTRIES = 128;
const cache = new Map<string, string>();

function cacheParentTransaction(txid: string, hex: string): void {
  if (!cache.has(txid) && cache.size >= MAX_PARENT_TRANSACTION_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (typeof oldest === 'string') cache.delete(oldest);
  }
  cache.set(txid, hex);
}

/** Clear the cache — only useful for tests and network switches. */
export function clearParentTransactionCache(): void {
  cache.clear();
}

/**
 * Raw hex for each txid, keyed by txid.
 *
 * Throws when a parent cannot be retrieved: building the PSBT without it would
 * produce one the signer silently mis-signs, which is far worse than failing
 * here with something the user can act on.
 */
export async function fetchParentTransactions(
  txids: readonly string[]
): Promise<Map<string, string>> {
  const wanted = Array.from(new Set(txids.filter(Boolean)));
  const missing = wanted.filter((txid) => !cache.has(txid));

  if (missing.length > 0) {
    const server = ElectrumServer();
    const responses = await server.requestMany(
      missing.map((txid) => ({
        method: 'blockchain.transaction.get',
        params: [txid, false],
      }))
    );
    responses.forEach((response, index) => {
      const txid = missing[index];
      if (response instanceof Error) return;
      if (typeof response !== 'string' || response.length === 0) return;
      cacheParentTransaction(txid, response);
    });
  }

  const resolved = new Map<string, string>();
  const unresolved: string[] = [];
  for (const txid of wanted) {
    const hex = cache.get(txid);
    if (hex) resolved.set(txid, hex);
    else unresolved.push(txid);
  }
  if (unresolved.length > 0) {
    throw new Error(
      `Could not load the parent transaction for ${unresolved.length} ` +
        `selected coin${unresolved.length === 1 ? '' : 's'} ` +
        `(${unresolved[0].slice(0, 12)}…). The signer needs it to check the ` +
        'amount being spent. Check the network connection and try again.'
    );
  }
  return resolved;
}
