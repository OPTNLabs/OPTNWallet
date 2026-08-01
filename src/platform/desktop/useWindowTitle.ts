// Say which wallet this window is showing, in its title bar.
//
// Electron Cash puts it right there — "Electron Cash 4.4.2 - phoenix_wallet
// [standard]" — and with several wallets open at once the title bar and the
// taskbar are the only places that distinguish one window from another. Ours
// said "OPTN Wallet" in every window, so the only way to tell them apart was to
// focus each one and look.
//
// Deliberately not shown: the wallet's database id. It is ours, not the user's,
// and a number in front of a wallet name reads as a window number.

import { useEffect } from 'react';
import { useSelector } from 'react-redux';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getVersion } from '@tauri-apps/api/app';

import { selectWalletId, selectWalletType } from '../../state/slices/walletSlice';
import DatabaseService from '../../apis/DatabaseManager/DatabaseService';
import { logError } from '../../utils/errorHandling';

const APP_NAME = 'OPTN Wallet';

async function walletNameOf(walletId: number): Promise<string | null> {
  const dbService = DatabaseService();
  await dbService.ensureDatabaseStarted();
  const db = dbService.getDatabase();
  if (!db) return null;

  const query = db.prepare('SELECT wallet_name FROM wallets WHERE id = ?');
  try {
    query.bind([walletId]);
    if (!query.step()) return null;
    const row = query.getAsObject() as Record<string, unknown>;
    return typeof row.wallet_name === 'string' && row.wallet_name
      ? row.wallet_name
      : null;
  } finally {
    query.free();
  }
}

export function useWindowTitle(): void {
  const walletId = useSelector(selectWalletId);
  const walletType = useSelector(selectWalletType);

  useEffect(() => {
    // Guards a late lookup from overwriting the title after the user has
    // already locked this wallet or opened a different one.
    let current = true;

    void (async () => {
      try {
        // Version is decoration; the wallet name is the point. Fetched
        // separately so a missing app permission costs the version number
        // rather than the whole title — which is exactly how the first attempt
        // at this failed: setTitle was not permitted, the throw was caught, and
        // the title silently stayed "OPTN Wallet".
        const version = await getVersion().catch(() => '');
        const base = version ? `${APP_NAME} ${version}` : APP_NAME;

        if (!walletId) {
          if (current) await getCurrentWindow().setTitle(base);
          return;
        }

        const name = await walletNameOf(walletId);
        if (!current) return;

        // No name means the row is gone or unreadable. Falling back to the base
        // title is better than inventing a name or showing the id.
        const title = name
          ? `${base}  -  ${name}${walletType ? `  [${walletType}]` : ''}`
          : base;
        await getCurrentWindow().setTitle(title);
      } catch (error) {
        // A title is cosmetic; never let it break the window. Logged loudly
        // enough to be findable, because a swallowed permission error here
        // looks identical to "the feature was never wired up".
        logError('useWindowTitle', error, { walletId });
        console.warn('[useWindowTitle] could not set the window title:', error);
      }
    })();

    return () => {
      current = false;
    };
  }, [walletId, walletType]);
}
