import { describe, expect, it } from 'vitest';
import { Network } from '../../../state/slices/networkSlice';
import { buildBip44Path } from '../hardwareWalletSigning';

// Regression test for a real bug found in review: this function used to
// hardcode 'defi' as BIP44 branch 2, diverging from the canonical
// BCH_STANDARD_BRANCH_INDEX / getBchAddressPath (HdWalletService.ts). A
// hardware-wallet request touching a 'defi'-branch UTXO would derive the
// wrong path and ask the device to sign with the wrong key.
describe('hardwareWalletSigning buildBip44Path', () => {
  it('derives the receive/change/defi branches at their canonical indices', () => {
    expect(buildBip44Path(Network.MAINNET, 'receive', 0)).toBe("m/44'/145'/0'/0/0");
    expect(buildBip44Path(Network.MAINNET, 'change', 3)).toBe("m/44'/145'/0'/1/3");
    expect(buildBip44Path(Network.MAINNET, 'defi', 5)).toBe("m/44'/145'/0'/7/5");
  });

  it('asks the hardware device for the same path the wallet derives', () => {
    // The device must be told the identical path, or it signs for an address
    // the wallet does not own. So this follows the wallet's coin type rather
    // than hard-coding one: chipnet moved to 145, and a device still asked for
    // m/44'/1'/... would return signatures for the wrong keys.
    const mainnetPath = buildBip44Path(Network.MAINNET, 'receive', 0);
    const chipnetPath = buildBip44Path(Network.CHIPNET, 'receive', 0);
    expect(chipnetPath).toBe("m/44'/145'/0'/0/0");
    expect(chipnetPath).toBe(mainnetPath);
  });
});
