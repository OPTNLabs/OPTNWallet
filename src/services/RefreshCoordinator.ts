type WalletTask<T> = () => Promise<T>;

const inFlightByKey = new Map<string, Promise<unknown>>();
const recentFinishedAtByKey = new Map<string, number>();

const DEFAULT_COOLDOWN_MS = 1500;

async function runWalletTask<T>(
  scope: string,
  walletId: number | null | undefined,
  task: WalletTask<T>,
  cooldownMs = DEFAULT_COOLDOWN_MS
): Promise<T> {
  const normalizedWalletId = walletId ?? 0;
  const key = `${scope}:${normalizedWalletId}`;
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

export function runWalletUtxoRefresh<T>(
  walletId: number | null | undefined,
  task: WalletTask<T>
): Promise<T> {
  return runWalletTask('utxo-refresh', walletId, task, 500);
}
