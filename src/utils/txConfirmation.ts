/**
 * Electrum history uses height > 0 for confirmed, 0/-1 for unconfirmed/mempool.
 * Fusion inject stamps height 0 + a client timestamp — so timestamp alone is
 * NOT a confirmation signal (would mark unconfirmed CoinJoins as confirmed).
 */
export function isTxConfirmed(tx: {
  height?: number | null;
  confirmations?: number | null;
}): boolean {
  if (
    typeof tx.confirmations === 'number' &&
    Number.isFinite(tx.confirmations) &&
    tx.confirmations > 0
  ) {
    return true;
  }
  return typeof tx.height === 'number' && Number.isFinite(tx.height) && tx.height > 0;
}

/** Prefer a positive (confirmed) height over unconfirmed 0/-1. */
export function preferHistoryHeight(
  incoming?: number | null,
  existing?: number | null
): number {
  const a =
    typeof incoming === 'number' && Number.isFinite(incoming) ? incoming : 0;
  const b =
    typeof existing === 'number' && Number.isFinite(existing) ? existing : 0;
  if (a > 0 && b > 0) return Math.max(a, b);
  if (a > 0) return a;
  if (b > 0) return b;
  return a !== 0 ? a : b;
}
