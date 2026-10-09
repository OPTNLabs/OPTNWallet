// Coin-control labels for the watch-only (SeedCash) send flow.
//
// What a coin carries -- BCH, a fungible token such as MUSD or FURU, an NFT --
// and whether a BCH send may spend it are decided in Rust
// (crates/optn-core/src/coin_control.rs). This file only carries values
// across the WASM boundary: a coin's reported token fields and the wallet's
// resolved identity in, a label out.
import { hexToBin } from '@bitauth/libauth';

import type { BcmrTokenMetadataState } from '../../types/bcmr';
import type { UTXO } from '../../types/types';
import {
  coinControlLabel,
  ensureOptnCore,
  spentOutputLabel,
} from '../../wasm/optn-core';

/** Mirrors `optn_core::coin_control::CoinLabel`. */
export type CoinControlLabel = {
  kind: 'bch' | 'fungible' | 'nft' | 'fungible_nft' | 'unreadable_tokens';
  title: string;
  name: string | null;
  category: string | null;
  category_short: string | null;
  amount: string | null;
  nft_capability: 'Immutable' | 'Mutable' | 'Minting' | null;
  caveat: string | null;
  bch_send_refusal: string | null;
};

/**
 * Label `utxos`, in order. Only the wallet-scoped Rust projection carries an
 * identity status, so metadata without one is passed as no identity and Rust
 * names nothing with it. Throws only when the WASM core is unavailable.
 */
export function labelCoins(
  utxos: readonly UTXO[],
  metadataByCategory: Readonly<
    Record<string, BcmrTokenMetadataState | undefined>
  >
): CoinControlLabel[] {
  ensureOptnCore();
  return utxos.map((utxo) => {
    const token = utxo.token;
    // Server-reported values travel as strings; Rust judges them.
    const category = token ? String(token.category ?? '') : undefined;
    // useSharedTokenMetadata keys its result by trimmed, lowercased category.
    const metadata = category
      ? metadataByCategory[category.trim().toLowerCase()]
      : undefined;
    const identity = metadata?.identityStatus ? metadata : undefined;
    return JSON.parse(
      coinControlLabel(
        category,
        // Decimal string: amounts reach 2^63 - 1, past a JS number.
        token ? String(token.amount ?? 0) : undefined,
        token?.nft ? String(token.nft.capability ?? '') : undefined,
        identity?.name,
        identity?.symbol || undefined,
        identity?.decimals,
        identity?.identityStatus
      )
    ) as CoinControlLabel;
  });
}

/**
 * The label of output `vout` of `txid`, read from its complete parent
 * transaction rather than from a server's coin list. Throws when the parent
 * is not that transaction or has no such output.
 */
export function labelSpentOutput(
  parentHex: string,
  txid: string,
  vout: number
): CoinControlLabel {
  ensureOptnCore();
  let json: string;
  try {
    json = spentOutputLabel(hexToBin(parentHex), txid, vout);
  } catch (error) {
    // wasm-bindgen throws the Rust error as a bare string.
    throw new Error(error instanceof Error ? error.message : String(error));
  }
  return JSON.parse(json) as CoinControlLabel;
}
