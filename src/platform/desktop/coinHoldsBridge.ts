import { invoke } from '@tauri-apps/api/core';
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
  return invoke<CoinHold[]>('optn_coin_holds', { walletId });
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
