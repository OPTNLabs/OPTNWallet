import { describe, expect, it } from 'vitest';
import { Network } from '../../../state/slices/networkSlice';
import { getBchAccountPath } from '../../HdWalletService';
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

  // The device must be asked for the same path the wallet derives locally. If
  // these ever diverge the hardware wallet signs with a key the wallet does not
  // own, so assert against getBchAccountPath rather than a literal coin type —
  // changing the network default must not be able to separate them.
  it('follows the wallet account path on every network', () => {
    for (const network of [Network.MAINNET, Network.CHIPNET]) {
      expect(buildBip44Path(network, 'receive', 0)).toBe(
        `${getBchAccountPath(network, 0)}/0/0`
      );
    }
  });

  it('honors a custom account path instead of the network default', () => {
    expect(
      buildBip44Path(Network.CHIPNET, 'change', 3, "m/44'/145'/2'")
    ).toBe("m/44'/145'/2'/1/3");
  });
});
