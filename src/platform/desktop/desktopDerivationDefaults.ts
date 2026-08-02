// What derivation path the DESKTOP build offers for a new wallet.
//
// BIP44 reserves coin type 1 for test networks, and the shared HdWalletService
// follows that literally — which is correct as a reading of the spec and wrong
// as a description of what BCH tooling does. Cashonize and the rest of the
// ecosystem stay on 145 for chipnet, so a seed created there shows different
// addresses in a wallet that uses 1, and the user is told their coins are gone.
//
// This is a DEFAULT for wallets created here, not a change to how anything is
// derived. It deliberately does not touch HdWalletService, for two reasons:
//
//   1. That file is the original author's and must stay conflict-free.
//   2. Changing the shared function moves EXISTING wallets to a different path.
//      That has already happened once in this project: wallets funded under
//      coin type 1 were migrated to 145, scanned a path that never held their
//      coins, and reported a zero balance with their history still visible.
//      A default that only applies at creation cannot do that.

import { Network } from '../../state/slices/networkSlice';
import { getBchAccountPath } from '../../services/HdWalletService';

/** BCH's registered coin type — used on both chains by current tooling. */
const BCH_COIN_TYPE = 145;

/**
 * Account path to pre-fill when creating or importing a wallet on the desktop.
 *
 * The field stays editable. Anyone restoring a wallet made by software that
 * used coin type 1 can type it, which is the whole point of the field existing.
 */
export function defaultDesktopAccountPath(
  network: Network,
  accountIndex = 0
): string {
  if (network === Network.CHIPNET) {
    return `m/44'/${BCH_COIN_TYPE}'/${accountIndex}'`;
  }
  return getBchAccountPath(network, accountIndex);
}
