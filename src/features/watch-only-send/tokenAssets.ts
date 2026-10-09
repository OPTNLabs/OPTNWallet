// The tokens a watch-only (SeedCash) send can pay, and the payment a choice
// among them describes. Presentation helpers: Rust plans the send.
import type { TokenPayment } from '../../services/psbt/tokenSend';

/** A token the wallet can send, as the screen derives it from its coins. */
export type TokenAsset =
  | {
      kind: 'fungible';
      category: string;
      /** Ticker or name, else the shortened category. */
      title: string;
      categoryShort: string;
      decimals: number;
      /** Every unit the wallet's spendable coins carry, in base units. */
      total: bigint;
    }
  | {
      kind: 'nft';
      /** `txid:vout` of the coin carrying it. */
      outpoint: string;
      category: string;
      title: string;
      categoryShort: string;
      capability: string;
      commitment: string;
    };

export function assetKey(asset: TokenAsset): string {
  return asset.kind === 'fungible'
    ? `ft:${asset.category}`
    : `nft:${asset.outpoint}`;
}

/** Base units as the token's own decimal amount, e.g. 1250 at 2 -> "12.5". */
export function formatTokenUnits(units: bigint, decimals: number): string {
  if (decimals <= 0) return units.toString();
  const scale = 10n ** BigInt(decimals);
  const fraction = (units % scale)
    .toString()
    .padStart(decimals, '0')
    .replace(/0+$/, '');
  return fraction ? `${units / scale}.${fraction}` : (units / scale).toString();
}

/** The payment a choice describes, or null for a BCH send. */
export function tokenPaymentFor(
  asset: TokenAsset | undefined,
  amountText: string,
  sendAll: boolean
): TokenPayment | null {
  if (!asset) return null;
  if (asset.kind === 'nft') return { kind: 'nft', outpoint: asset.outpoint };
  return sendAll
    ? { kind: 'all_fungible', category: asset.category }
    : {
        kind: 'fungible',
        category: asset.category,
        amount: amountText,
        decimals: asset.decimals,
      };
}
