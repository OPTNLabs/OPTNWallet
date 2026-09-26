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

type EngineWalletSession = { active: string | null; epoch: number };

/** Public high-water marks only. Rust proves ownership and persists them. */
async function importLegacyHdInventory(
  walletId: number,
  handle: string,
  opened: EngineWalletSession
): Promise<void> {
  if (
    opened?.active !== handle ||
    !Number.isSafeInteger(opened.epoch) ||
    opened.epoch < 0
  ) {
    throw new Error('The engine did not open the selected wallet session.');
  }

  const [{ default: DatabaseService }, hd] = await Promise.all([
    import('../../apis/DatabaseManager/DatabaseService'),
    import('../../services/HdWalletService'),
  ]);
  // Unlock already started the database. Do not initialize/migrate secret
  // storage merely to read this public inventory.
  const db = DatabaseService().getDatabase();
  if (!db) throw new Error('Public wallet database is unavailable.');
  const readRow = (sql: string, params: number[]) => {
    const query = db.prepare(sql);
    try {
      query.bind(params);
      return query.step() ? query.getAsObject() : null;
    } finally {
      query.free();
    }
  };
  const wallet = readRow(
    'SELECT derivation_path FROM wallets WHERE id = ? LIMIT 1',
    [walletId]
  );
  if (typeof wallet?.derivation_path !== 'string') {
    throw new Error('Public wallet derivation path is unavailable.');
  }
  const accountPath = hd.normalizeBchAccountPath(wallet.derivation_path);
  const { accountIndex } = hd.parseBchAccountPath(accountPath);
  const unsupported = readRow(
    `SELECT account_index FROM keys
     WHERE wallet_id = ? AND change_index IN (0, 1, 7, 2)
       AND (typeof(account_index) != 'integer' OR account_index != ?)
     LIMIT 1`,
    [walletId, accountIndex]
  );
  if (unsupported) {
    throw new Error(
      `Legacy inventory contains unsupported accounts; only ${accountPath} can be imported.`
    );
  }
  const malformed = readRow(
    `SELECT address, account_index, change_index, address_index FROM keys
     WHERE wallet_id = ? AND (typeof(change_index) != 'integer'
       OR (account_index = ? AND change_index IN (0, 1, 7, 2) AND (
         typeof(address_index) != 'integer' OR address_index < 0 OR address_index > ?
         OR typeof(address) != 'text' OR length(trim(address)) = 0 OR length(address) > 255)))
     LIMIT 1`,
    [walletId, accountIndex, hd.MAX_BIP44_INDEX]
  );
  if (malformed) {
    throw new Error(
      'Legacy inventory contains malformed or unsupported addresses.'
    );
  }
  const addresses: Array<{ branch: number; index: number; address: string }> =
    [];
  // RPA keys and contract branches have separate inventory/ownership rules.
  for (const branch of [0, 1, 7, 2]) {
    const row = readRow(
      `SELECT address, account_index, change_index, address_index FROM keys
       WHERE wallet_id = ? AND account_index = ? AND change_index = ?
       ORDER BY address_index DESC LIMIT 1`,
      [walletId, accountIndex, branch]
    );
    if (row) {
      addresses.push({
        branch,
        index: row.address_index as number,
        address: row.address as string,
      });
    }
  }
  const current = await invoke<EngineWalletSession>('optn_wallet_security', {
    request: { command: 'status' },
  });
  if (current?.active !== handle || current.epoch !== opened.epoch) {
    throw new Error(
      'The engine wallet changed before legacy inventory import.'
    );
  }
  if (!addresses.length) return;
  const imported = await invoke<EngineWalletSession>('optn_wallet_security', {
    request: {
      command: 'import_hd_inventory',
      epoch: opened.epoch,
      account_path: accountPath,
      addresses,
    },
  });
  if (imported?.active !== handle || imported.epoch !== opened.epoch) {
    throw new Error(
      'The engine wallet changed during legacy inventory import.'
    );
  }
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
  let failureContext = 'Engine wallet open failed';
  try {
    if (typeof autoLockMinutes === 'number') {
      await shareAutoLockChoice(autoLockMinutes);
    }
    const opened = await invoke<EngineWalletSession>('optn_wallet_security', {
      request: { command: 'open', handle, password },
    });
    failureContext = 'Wallet opened, but legacy HD inventory migration failed';
    await importLegacyHdInventory(walletId, handle, opened);
    return { opened: true };
  } catch (error) {
    return {
      opened: false,
      // Existing callers warn on !opened; never claim a completed handoff
      // when the public database read, ownership check, or durable import failed.
      reason: `${failureContext}: ${error instanceof Error ? error.message : String(error)}`,
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
