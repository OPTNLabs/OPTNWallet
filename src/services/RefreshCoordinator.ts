type WalletTask<T> = () => Promise<T>;

const inFlightByKey = new Map<string, Promise<unknown>>();
const recentFinishedAtByKey = new Map<string, number>();

const DEFAULT_COOLDOWN_MS = 1500;

function taskKey(scope: string, walletId: number | null | undefined): string {
  return `${scope}:${walletId ?? 0}`;
}

async function runWalletTask<T>(
  scope: string,
  walletId: number | null | undefined,
  task: WalletTask<T>,
  cooldownMs = DEFAULT_COOLDOWN_MS
): Promise<T> {
  const normalizedWalletId = walletId ?? 0;
  const key = taskKey(scope, normalizedWalletId);
  const inflight = inFlightByKey.get(key) as Promise<T> | undefined;
  if (inflight) return inflight;

  const lastFinishedAt = recentFinishedAtByKey.get(key) ?? 0;
  if (Date.now() - lastFinishedAt < cooldownMs) {
    return Promise.resolve(undefined as T);
  }

  const run = task()
    .finally(() => {
      inFlightByKey.delete(key);
      recentFinishedAtByKey.set(key, Date.now());
    });

  inFlightByKey.set(key, run);
  return run;
}

export function runOutboundReconcile<T>(
  walletId: number | null | undefined,
  task: WalletTask<T>
): Promise<T> {
  return runWalletTask('outbound-reconcile', walletId, task, 1000);
}

export function runWalletHistoryRefresh<T>(
  walletId: number | null | undefined,
  task: WalletTask<T>
): Promise<T> {
  return runWalletTask('history-refresh', walletId, task, 1000);
}

/**
 * Wait for a history scan that started before a wallet boundary. The scan may
 * still be writing transaction rows after its caller has been invalidated, so
 * reconfiguration must let it finish before deleting the old wallet records.
 */
export async function waitForWalletHistoryRefresh(
  walletId: number | null | undefined,
  options: { resetCooldown?: boolean } = {}
): Promise<void> {
  // Background auto-refresh and user Manual Sync use separate scopes so a
  // user force never joins a silent background pass (55% freeze).
  for (const scope of ['history-refresh', 'history-refresh-user'] as const) {
    const key = taskKey(scope, walletId);
    const inflight = inFlightByKey.get(key);
    if (inflight) await inflight.catch(() => undefined);
    if (options.resetCooldown) recentFinishedAtByKey.delete(key);
  }
}

/**
 * User-initiated history refresh (Manual Sync / Rebuild).
 *
 * Separate scope from background `history-refresh` so we never join a silent
 * open/subscription pass (no onProgress → bar stuck at 55% for minutes) and
 * so we always run after statuses were cleared for a true force recheck.
 */
export async function runWalletHistoryRefreshExclusive<T>(
  walletId: number | null | undefined,
  task: WalletTask<T>
): Promise<T> {
  return runWalletTask('history-refresh-user', walletId, task, 0);
}

export function runWalletUtxoRefresh<T>(
  walletId: number | null | undefined,
  task: WalletTask<T>
): Promise<T> {
  return runWalletTask('utxo-refresh', walletId, task, 500);
}

/**
 * User/spend-critical UTXO refresh (fusion, explicit menu refresh).
 *
 * Background `utxo-refresh` is shared: joining it then discarding the snapshot
 * (because "we did not start it") made every Fuse click during a subscription
 * reconcile return null → "Syncing wallet coins — try again". Wait for any
 * background pass, then run our own exclusive task so fusion always gets a
 * real listunspent of its own.
 */
export async function runWalletUtxoRefreshExclusive<T>(
  walletId: number | null | undefined,
  task: WalletTask<T>
): Promise<T> {
  const bgKey = taskKey('utxo-refresh', walletId);
  const inflight = inFlightByKey.get(bgKey);
  if (inflight) await inflight.catch(() => undefined);
  // Separate scope + zero cooldown: never join, never soft-return undefined.
  return runWalletTask('utxo-refresh-user', walletId, task, 0);
}
