// Default account path for create/import on desktop.
//
// HdWalletService.getBchCoinType() is 145 for both mainnet and chipnet (BCH
// ecosystem convention). Existing wallets keep whatever derivation_path is
// stored in SQLite; this helper only pre-fills the UI.

import { Network } from '../../state/slices/networkSlice';
import { getBchAccountPath } from '../../services/HdWalletService';

/**
 * Account path to pre-fill when creating or importing a wallet.
 * Always m/44'/145'/account' unless the user edits the field.
 */
export function defaultDesktopAccountPath(
  network: Network,
  accountIndex = 0
): string {
  return getBchAccountPath(network, accountIndex);
}
