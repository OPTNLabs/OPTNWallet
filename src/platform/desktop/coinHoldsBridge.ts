import { invoke } from '@tauri-apps/api/core';
import { store } from '../../state/store';
import { selectCurrentNetwork } from '../../state/selectors/networkSelectors';
import { toErrorMessage } from '../../utils/errorHandling';
import { isDesktopPlatform } from '../../utils/platform';

/**
 * Coins the wallet is not free to spend, and why.
 *
 * The rule lives in shared Rust (`optn_core::coins` / `optn_runtime::coin_holds`):
 * a held coin is out of ordinary send, Fusion selection and new pledges, and
 * only the user's own hold can be lifted from a coin list — a pledge, an
 * authhead and a running fusion are each held by something with a lifecycle.
 * This module carries that record across the boundary and nothing more, so a
 * screen cannot invent a hold or release one behind its owner's back.
 */
export type CoinHold = {
  /** `txid:vout`, lower-case txid — the key every screen here uses. */
  outpoint: string;
  txid: string;
  vout: number;
  reason: 'user' | 'flipstarter-pledge' | 'authhead' | 'fusion-in-flight';
  note: string | null;
  user_reversible: boolean;
};

export const HOLD_REASON_LABELS: Record<CoinHold['reason'], string> = {
  user: 'Frozen',
  'flipstarter-pledge': 'Pledged',
  authhead: 'Authhead',
  'fusion-in-flight': 'Fusing',
};

export function holdKey(txid: string, vout: number): string {
  return `${txid.toLowerCase()}:${vout}`;
}

export async function readCoinHolds(walletId: number): Promise<CoinHold[]> {
  if (!isDesktopPlatform()) return [];
  if (!Number.isSafeInteger(walletId) || walletId <= 0) {
    throw new Error('Select a wallet before reading coin holds.');
  }
  try {
    // On desktop, an unreadable persisted record is not an empty record.
    return await invoke<CoinHold[]>('optn_coin_holds', { walletId });
  } catch (error) {
    throw new Error(
      `Unable to read coin holds. Sending is blocked: ${toErrorMessage(error)}`
    );
  }
}

/** Bind an adapter operation to the wallet session/network that started it. */
export function coinHoldScope(walletId?: number) {
  const state = store.getState();
  return {
    walletId: walletId ?? state.wallet_id.currentWalletId,
    activeWalletId: state.wallet_id.currentWalletId,
    sessionGeneration: state.wallet_id.sessionGeneration,
    network: selectCurrentNetwork(state),
  };
}

export type CoinHoldScope = ReturnType<typeof coinHoldScope>;

export function assertCoinHoldScope(scope: CoinHoldScope): void {
  const current = coinHoldScope(scope.walletId);
  if (
    current.activeWalletId !== scope.activeWalletId ||
    current.sessionGeneration !== scope.sessionGeneration ||
    current.network !== scope.network
  ) {
    throw new Error('Wallet or network changed. Review the transaction again.');
  }
}

export async function readScopedCoinHolds(
  scope: CoinHoldScope
): Promise<Set<string>> {
  assertCoinHoldScope(scope);
  const holds = heldOutpointSet(await readCoinHolds(scope.walletId));
  assertCoinHoldScope(scope);
  return holds;
}

/** Consume Rust's hold record; reasons and release policy remain in Rust. */
export async function assertCoinsNotHeld(
  scope: CoinHoldScope,
  inputs: ReadonlyArray<{ tx_hash: string; tx_pos: number }>
): Promise<void> {
  const holds = await readScopedCoinHolds(scope);
  if (inputs.some((input) => holds.has(holdKey(input.tx_hash, input.tx_pos)))) {
    throw new Error(
      'A selected coin is frozen or reserved. Review the transaction again.'
    );
  }
}

export async function freezeCoin(
  walletId: number,
  txid: string,
  vout: number,
  note?: string
): Promise<CoinHold[]> {
  return invoke<CoinHold[]>('optn_coin_freeze', {
    walletId,
    txid,
    vout,
    note: note ?? null,
  });
}

export async function unfreezeCoin(
  walletId: number,
  txid: string,
  vout: number
): Promise<CoinHold[]> {
  return invoke<CoinHold[]>('optn_coin_unfreeze', { walletId, txid, vout });
}

/** Held outpoints as a lookup, for filtering a spend's candidate coins. */
export function heldOutpointSet(holds: CoinHold[]): Set<string> {
  return new Set(holds.map((hold) => holdKey(hold.txid, hold.vout)));
}
