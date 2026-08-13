// What a window must forget when it stops holding a wallet.
//
// Locking or switching wallets wipes the key and the redux state, but this
// window's sql.js database is loaded once at startup and never reloaded, and
// the per-wallet save baselines are taken from it. Left alone, both go stale as
// soon as any other window writes — and the staleness is undetectable from
// here.
//
// Reopening a wallet on that stale copy then fails the concurrent-edit check in
// realSaveDatabase forever, because nothing refreshes either side of the
// comparison. Every save is refused, including the UTXO write, so the wallet
// reports a successful sync and displays no balance until the app is restarted.

import DatabaseService from '../../apis/DatabaseManager/DatabaseService';
import { logError } from '../../utils/errorHandling';

/**
 * Rebase this window on the persisted database after a wallet is closed.
 *
 * Safe only once no wallet is open — it adopts the on-disk copy wholesale.
 * That is correct here: there is nothing unsaved left to lose, disk is by
 * definition at least as new as what we held, and UTXO and address rows are
 * re-derived from the chain on the next sync.
 *
 * Deliberately fire-and-forget. A wallet has already been closed by the time
 * this runs; failing to rebase must not block the user returning to the picker,
 * and the next close (or a restart) will try again.
 */
export function resyncAfterWalletClosed(context: string): void {
  void DatabaseService()
    .resyncDatabaseFromDisk()
    .catch((error) => logError(`${context}.resyncDatabase`, error));
}
