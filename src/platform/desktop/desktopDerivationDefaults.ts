// Default account path for create/import on desktop.
//
// HdWalletService.getBchCoinType() selects 145 for mainnet and 1 for chipnet.
// Existing wallets keep whatever derivation_path is stored in SQLite; this
// helper only pre-fills the UI.

import { Network } from '../../state/slices/networkSlice';
import { getBchAccountPath } from '../../services/HdWalletService';

/**
 * Account path to pre-fill when creating or importing a wallet.
 * Uses the network default unless the user edits the field.
 */
export function defaultDesktopAccountPath(
  network: Network,
  accountIndex = 0
): string {
  return getBchAccountPath(network, accountIndex);
}
