import { invoke } from '@tauri-apps/api/core';
import { isDesktopPlatform } from '../../utils/platform';
import { findWalletFileRelForSourceId } from './walletFile';
import type { NftCategory } from '@bitauth/libauth';
import type { BcmrTokenMetadataState } from '../../types/bcmr';

/**
 * Open the wallet that is already open in this renderer in the Rust runtime too.
 *
 * Both read the same `.optn` file — the runtime's `WalletFile` is the format
 * this desktop build writes — so this is the same wallet, not a copy. Handing
 * the runtime its password at unlock is what lets the shared engine synchronize
 * the account through the multi-source chain stack instead of keeping a second,
 * unrelated idea of the wallet.
 *
 * It is best-effort on purpose: the wallet is already open and usable here, so
 * a runtime that refuses must not fail the unlock the user just completed. The
 * password is passed straight through and never stored or logged.
 */
export type EngineWalletSync = {
  refreshing: boolean;
  historyFresh: boolean;
  utxosFresh: boolean;
  source: string | null;
  evidence: string | null;
  tipHeight: number | null;
  confirmedSats: number | null;
  pendingSats: number;
  error: string | null;
};

/** The runtime addresses a wallet by its file name. */
export async function engineHandleFor(
  walletId: number
): Promise<string | null> {
  const relative = await findWalletFileRelForSourceId(walletId);
  if (!relative) return null;
  const name = relative.split('/').pop();
  return name && name.endsWith('.optn') ? name : null;
}

/**
 * Carry this device's existing auto-lock choice to the runtime.
 *
 * A wallet file written by another interface is refused until the runtime has
 * an auto-lock setting, so that opening one cannot silently adopt a default the
 * holder never picked. The value passed here is the choice they already made in
 * this same application (Settings → App lock, the same Never/15/30/60/120/240
 * set the runtime offers), which is why carrying it across is faithful rather
 * than a guess. Nothing is invented when there is no choice to carry.
 */
export async function shareAutoLockChoice(minutes: number): Promise<void> {
  if (!isDesktopPlatform()) return;
  if (!Number.isInteger(minutes) || minutes < 0) return;
  await invoke('optn_app_dispatch', {
    action: {
      version: 1,
      action: { type: 'set_auto_lock_minutes', value: minutes },
    },
  });
}

export async function openWalletInEngine(
  walletId: number,
  password: string,
  autoLockMinutes?: number
): Promise<{ opened: boolean; reason?: string }> {
  if (!isDesktopPlatform()) return { opened: false, reason: 'not desktop' };
  const handle = await engineHandleFor(walletId);
  if (!handle) {
    // Watch-only and hardware wallets may have no file mirror; nothing to open.
    return { opened: false, reason: 'no wallet file for this wallet' };
  }
  try {
    if (typeof autoLockMinutes === 'number') {
      await shareAutoLockChoice(autoLockMinutes);
    }
    await invoke('optn_wallet_security', {
      request: { command: 'open', handle, password },
    });
    return { opened: true };
  } catch (error) {
    return {
      opened: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Synchronize the open account through the shared chain stack. */
export async function refreshEngineWallet(): Promise<void> {
  await invoke('optn_wallet_refresh');
}

/** What the runtime currently believes about that account. */
export async function readEngineWalletSync(): Promise<EngineWalletSync | null> {
  if (!isDesktopPlatform()) return null;
  try {
    const snapshot = await invoke<{
      wallet?: unknown;
      wallet_sync?: {
        refreshing?: boolean;
        history_fresh?: boolean;
        utxos_fresh?: boolean;
        source?: string | null;
        evidence?: string | null;
        tip_height?: number | null;
        confirmed_sats?: number | null;
        pending_sats?: number;
        error?: string | null;
      };
    }>('optn_app_snapshot');
    const sync = snapshot?.wallet_sync;
    if (!sync || !snapshot?.wallet) return null;
    return {
      refreshing: Boolean(sync.refreshing),
      historyFresh: Boolean(sync.history_fresh),
      utxosFresh: Boolean(sync.utxos_fresh),
      source: sync.source ?? null,
      evidence: sync.evidence ?? null,
      tipHeight: sync.tip_height ?? null,
      confirmedSats:
        typeof sync.confirmed_sats === 'number' ? sync.confirmed_sats : null,
      pendingSats: sync.pending_sats ?? 0,
      error: sync.error ?? null,
    };
  } catch {
    return null;
  }
}

/** Mirrors WireTokenIdentity; Rust validates and authenticates presentation. */
export type EngineTokenIdentity = {
  name: string;
  ticker: string | null;
  decimals: number;
  status: string;
  presentation?: {
    description: string | null;
    uris: Record<string, string>;
    nfts: NftCategory | null;
  };
};

export function projectEngineTokenMetadata(
  category: string,
  identity?: EngineTokenIdentity
): BcmrTokenMetadataState {
  const identityStatus =
    identity?.status === 'verified' ||
    identity?.status === 'stale' ||
    identity?.status === 'unpublished'
      ? identity.status
      : 'unresolved';
  const known = identityStatus === 'verified' || identityStatus === 'stale';
  return {
    identityStatus,
    status: 'ready',
    freshness:
      identityStatus === 'verified'
        ? 'fresh'
        : known
          ? 'cached'
          : 'unavailable',
    name: known ? identity!.name : category,
    symbol: known ? identity!.ticker ?? '' : '',
    decimals: known ? identity!.decimals : 0,
    // A registry URI is not fetched image bytes. No privacy-safe image port yet.
    iconUri: null,
    snapshot: known
      ? {
          name: identity!.name,
          description: identity!.presentation?.description ?? undefined,
          uris: identity!.presentation?.uris ?? {},
          token: {
            category,
            symbol: identity!.ticker ?? '',
            decimals: identity!.decimals,
            nfts: identity!.presentation?.nfts ?? undefined,
          },
        }
      : null,
    isRefreshing: false,
  };
}

/** Read only: never starts sync, opens a wallet, or falls back to an indexer. */
export async function readEngineTokenMetadata(
  walletId: number,
  network: string,
  categories: string[]
): Promise<Record<string, BcmrTokenMetadataState> | null> {
  if (!isDesktopPlatform() || walletId <= 0) return null;
  try {
    const handle = await engineHandleFor(walletId);
    if (!handle) return null;
    const snapshot = await invoke<{
      version: number;
      network: string;
      wallet: unknown;
      unlock_epoch: number;
      token_identities?: Record<string, EngineTokenIdentity>;
    }>('optn_app_snapshot');
    // Read status after the snapshot: an intervening lock/open changes epoch.
    const session = await invoke<{ active: string | null; epoch: number }>(
      'optn_wallet_security',
      { request: { command: 'status' } }
    );
    if (
      snapshot.version !== 1 ||
      !snapshot.wallet ||
      snapshot.network !== network ||
      session.active !== handle ||
      !Number.isSafeInteger(snapshot.unlock_epoch) ||
      snapshot.unlock_epoch !== session.epoch
    )
      return null;
    return Object.fromEntries(
      categories.map((category) => [
        category,
        projectEngineTokenMetadata(
          category,
          snapshot.token_identities?.[category]
        ),
      ])
    );
  } catch {
    return null;
  }
}
