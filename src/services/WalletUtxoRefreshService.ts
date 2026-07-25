import { store } from '../state/store';
import { replaceAllUTXOs } from '../state/slices/utxoSlice';
import type { UTXO } from '../types/types';
import { primeUTXOCache } from './ElectrumService';
import KeyService from './KeyService';
import QuantumrootTrackingService from './QuantumrootTrackingService';
import { runWalletUtxoRefresh } from './RefreshCoordinator';
import UTXOService from './UTXOService';

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

/**
 * Fetch one complete wallet snapshot from addresses owned or explicitly tracked
 * by that wallet. A stale caller gets `null` and must not update Redux.
 */
export async function fetchActiveWalletUtxos(
  session: WalletSession
): Promise<Record<string, UTXO[]> | null> {
  if (!isActiveWalletSession(session)) return null;
  const { walletId } = session;

  const keyPairs = await KeyService.retrieveKeys(walletId);
  if (!isActiveWalletSession(session)) return null;

  const quantumrootAddresses =
    await QuantumrootTrackingService.listTrackedAddresses(walletId);
  if (!isActiveWalletSession(session)) return null;

  const addresses = Array.from(
    new Set(
      [
        ...(keyPairs ?? []).map((keyPair) => keyPair.address),
        ...quantumrootAddresses,
      ].filter(Boolean)
    )
  );
  const fetched = await UTXOService.fetchAndStoreUTXOsMany(walletId, addresses);
  if (!isActiveWalletSession(session)) return null;

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
  walletId: number
): Promise<Record<string, UTXO[]> | null> {
  const session = captureActiveWalletSession(walletId);
  if (!session) return null;

  const snapshot = await runWalletUtxoRefresh(walletId, async () =>
    fetchActiveWalletUtxos(session)
  );
  if (!snapshot || !isActiveWalletSession(session)) return null;

  store.dispatch(replaceAllUTXOs({ utxosByAddress: snapshot }));
  return snapshot;
}

export async function refreshActiveWalletUtxos(
  walletId: number
): Promise<boolean> {
  return (await reconcileActiveWalletUtxos(walletId)) !== null;
}
