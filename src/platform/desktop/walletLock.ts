// Cross-window mutual exclusion per wallet, through the Web Locks API: the
// lock serialises same-origin windows where localStorage alone cannot.

const LOCK_PREFIX = 'optn-fusion-lock-';

type LockManagerLike = {
  request: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
};

function lockManager(): LockManagerLike | null {
  const candidate = (globalThis as { navigator?: { locks?: LockManagerLike } })
    .navigator?.locks;
  return candidate && typeof candidate.request === 'function'
    ? candidate
    : null;
}

/**
 * Run `critical` with cross-window exclusivity for this wallet.
 *
 * Returns `{ ran: false }` when no lock manager exists, so callers can tell
 * "ran and produced a result" from "could not guarantee exclusivity" and
 * decide for themselves.
 */
export async function withWalletLock<T>(
  walletId: number,
  critical: () => T | Promise<T>
): Promise<{ ran: true; value: T } | { ran: false }> {
  const locks = lockManager();
  if (!locks) return { ran: false };
  const value = await locks.request(`${LOCK_PREFIX}${walletId}`, async () =>
    critical()
  );
  return { ran: true, value };
}
