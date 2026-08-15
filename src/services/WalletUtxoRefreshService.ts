import { store } from '../state/store';
import { replaceAllUTXOs } from '../state/slices/utxoSlice';
import type { UTXO } from '../types/types';
import { invalidateUTXOCache, primeUTXOCache } from './ElectrumService';
import KeyService from './KeyService';
import QuantumrootTrackingService from './QuantumrootTrackingService';
import {
  runWalletUtxoRefresh,
  runWalletUtxoRefreshExclusive,
} from './RefreshCoordinator';
import UTXOService from './UTXOService';

export type WalletUtxoSnapshot = Readonly<
  Record<string, readonly UTXO[]>
>;
type WalletUtxoRefreshListener = (
  walletId: number,
  snapshot: WalletUtxoSnapshot
) => void;
const refreshListeners = new Set<WalletUtxoRefreshListener>();

/**
 * Notify app-wide consumers after a fresh wallet snapshot is committed.
 *
 * Auto-fusion uses this as its wallet-activity wake-up signal (receive, send,
 * change, any UTXO-changing tx). The durable cooldown and wallet lease remain
 * authoritative, so a burst of Electrum notifications cannot start duplicate
 * paid rounds. Depth-met idle is cleared only when coins are again below depth.
 */
export function subscribeWalletUtxoRefresh(
  listener: WalletUtxoRefreshListener
): () => void {
  refreshListeners.add(listener);
  return () => refreshListeners.delete(listener);
}

function emitWalletUtxoRefresh(
  walletId: number,
  snapshot: WalletUtxoSnapshot
): void {
  for (const listener of refreshListeners) {
    try {
      listener(walletId, snapshot);
    } catch {
      // A UI wake-up listener must never turn a successful wallet sync into a
      // failed sync for every other consumer.
    }
  }
}

export interface WalletSession {
  walletId: number;
  generation: number;
}

export function captureActiveWalletSession(
  walletId: number
): WalletSession | null {
  const activeWallet = store.getState().wallet_id;
  if (walletId <= 0 || activeWallet.currentWalletId !== walletId) return null;
  return {
    walletId,
    generation: activeWallet.sessionGeneration ?? 0,
  };
}

export function isActiveWalletSession(session: WalletSession): boolean {
  const activeWallet = store.getState().wallet_id;
  return (
    session.walletId > 0 &&
    activeWallet.currentWalletId === session.walletId &&
    (activeWallet.sessionGeneration ?? 0) === session.generation
  );
}

export type FetchActiveWalletUtxosOptions = {
  /**
   * When false, skip BIP44 gap-limit rediscovery and only refresh known
   * addresses. Manual Home "Sync" uses this after open already ran discovery —
   * re-running discovery + history was the "slow old path".
   */
  discover?: boolean;
  /**
   * Full wallet pass flag (open / Manual Sync). HOT always listunspents every
   * address in the call; force remains for API compatibility.
   */
  force?: boolean;
  onProgress?: (completedCount: number, totalCount: number) => void;
};

/**
 * Fetch one complete wallet snapshot from addresses owned or explicitly tracked
 * by that wallet. A stale caller gets `null` and must not update Redux.
 */
export async function fetchActiveWalletUtxos(
  session: WalletSession,
  signal?: AbortSignal,
  options: FetchActiveWalletUtxosOptions = {}
): Promise<Record<string, UTXO[]> | null> {
  if (signal?.aborted || !isActiveWalletSession(session)) return null;
  const { walletId } = session;
  const discover = options.discover !== false;

  options.onProgress?.(0, 1);
  const keyPairs = await KeyService.retrieveKeys(walletId);
  if (signal?.aborted || !isActiveWalletSession(session)) return null;

  const quantumrootAddresses =
    await QuantumrootTrackingService.listTrackedAddresses(walletId);
  if (signal?.aborted || !isActiveWalletSession(session)) return null;

  const addresses = Array.from(
    new Set(
      [
        ...(keyPairs ?? []).map((keyPair) => keyPair.address),
        ...quantumrootAddresses,
      ].filter(Boolean)
    )
  );
  // A wallet-wide reconciliation is triggered by new history, a block, or a
  // completed broadcast. Reusing the short Electrum UTXO cache here could
  // publish the exact stale snapshot that triggered the refresh.
  for (const address of addresses) invalidateUTXOCache(address);
  if (addresses.length > 0) {
    options.onProgress?.(0, addresses.length);
  }
  const fetched = await UTXOService.fetchAndStoreUTXOsMany(walletId, addresses, {
    discover,
    force: options.force === true,
    onProgress: options.onProgress,
  });
  if (signal?.aborted || !isActiveWalletSession(session)) return null;

  const snapshot: Record<string, UTXO[]> = {};
  const snapshotAddresses = Array.from(
    new Set([...addresses, ...Object.keys(fetched)])
  );
  for (const address of snapshotAddresses) {
    const utxos = fetched[address] ?? [];
    snapshot[address] = utxos;
    primeUTXOCache(address, utxos);
  }
  return snapshot;
}

export async function reconcileActiveWalletUtxos(
  walletId: number,
  signal?: AbortSignal
): Promise<Record<string, UTXO[]> | null> {
  if (signal?.aborted) return null;
  const session = captureActiveWalletSession(walletId);
  if (!session) return null;

  let executedThisRequest = false;
  let snapshot: Record<string, UTXO[]> | null | undefined;
  try {
    const coordinated = runWalletUtxoRefresh(walletId, async () => {
      executedThisRequest = true;
      return fetchActiveWalletUtxos(session, signal);
    });
    snapshot = signal
      ? await new Promise<Record<string, UTXO[]> | null>((resolve, reject) => {
          let finished = false;
          const finish = (
            value: Record<string, UTXO[]> | null,
            error?: unknown
          ) => {
            if (finished) return;
            finished = true;
            signal.removeEventListener('abort', onAbort);
            if (error === undefined) resolve(value);
            else reject(error);
          };
          const onAbort = () => finish(null);
          signal.addEventListener('abort', onAbort, { once: true });
          coordinated.then(
            (value) => finish(value),
            (error) => finish(null, error)
          );
          if (signal.aborted) onAbort();
        })
      : await coordinated;
  } catch (error) {
    // A rejection from a task we did not start belongs to an older trigger.
    // Preserve this newer trigger as a trailing retry; errors from our own
    // fetch still propagate to the caller for normal logging.
    if (!executedThisRequest) return null;
    throw error;
  }
  // The coordinator may return an older in-flight task for this wallet. That
  // result began before this trigger and cannot prove the new event is
  // reflected. Returning null asks callers to preserve one trailing refresh.
  if (!executedThisRequest) return null;
  if (signal?.aborted || !snapshot || !isActiveWalletSession(session))
    return null;

  // Publish HOT snapshot from listunspent/SQL. Do not refuse "drops" — that
  // kept fake-high Redux balances after a correct lower network result.
  store.dispatch(replaceAllUTXOs({ utxosByAddress: snapshot }));
  emitWalletUtxoRefresh(walletId, snapshot);
  return snapshot;
}

/**
 * Fusion / spend-critical reconcile: always runs its own listunspent.
 *
 * The shared `reconcileActiveWalletUtxos` joins background refreshes and then
 * discards the joined snapshot (soft null). That is correct for subscription
 * wake-ups that need a *trailing* refresh, but it made P2P/server fusion
 * permanently report "Syncing wallet coins" whenever Electrum was busy —
 * which on a live wallet is almost always.
 */
export async function reconcileActiveWalletUtxosForSpend(
  walletId: number,
  signal?: AbortSignal
): Promise<Record<string, UTXO[]> | null> {
  if (signal?.aborted) return null;
  const session = captureActiveWalletSession(walletId);
  if (!session) return null;

  const snapshot = await runWalletUtxoRefreshExclusive(walletId, async () =>
    fetchActiveWalletUtxos(session, signal, {
      // Fusion only needs spendable known coins — skip BIP44 rediscovery cost.
      discover: false,
      force: true,
    })
  );
  if (signal?.aborted || !snapshot || !isActiveWalletSession(session)) {
    return null;
  }

  store.dispatch(replaceAllUTXOs({ utxosByAddress: snapshot }));
  emitWalletUtxoRefresh(walletId, snapshot);
  return snapshot;
}

export async function refreshActiveWalletUtxos(
  walletId: number
): Promise<boolean> {
  return (await reconcileActiveWalletUtxos(walletId)) !== null;
}
