// Local-only CashFusion marker. Never on-chain — just UI for wallet-stored
// fuse depth / CoinJoin txids (fusionCoinDepth.ts).

import React from 'react';

type FusionBadgeProps = {
  /** Per-coin fuse depth (Electron Cash style). 0 = hide. */
  depth?: number;
  /**
   * Transaction-level badge (history/home) when we know the tx is a CoinJoin
   * but not necessarily a live coin's depth.
   */
  asTx?: boolean;
  className?: string;
};

/**
 * Green "Fused" / "Fused ×N" chip. Matches history + UTXO card styling.
 */
export function FusionBadge({
  depth = 0,
  asTx = false,
  className = '',
}: FusionBadgeProps): React.ReactElement | null {
  if (!asTx && (!Number.isFinite(depth) || depth < 1)) return null;
  const label = asTx
    ? 'Fused'
    : depth <= 1
      ? 'Fused'
      : `Fused ×${Math.trunc(depth)}`;
  return (
    <span
      className={
        `inline-block align-middle text-[10px] font-semibold ` +
        `bg-emerald-500/20 text-emerald-400 px-1.5 py-0.5 rounded ` +
        className
      }
      title={
        asTx
          ? 'This transaction was a CashFusion CoinJoin recorded by this wallet (local only).'
          : `This coin has been through ${Math.trunc(depth)} CashFusion round(s) (local wallet record only — not on-chain).`
      }
    >
      {label}
    </span>
  );
}

export default FusionBadge;
