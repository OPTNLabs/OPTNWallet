import KeyManager from '../../apis/WalletManager/KeyManager';
import {
  getUiFixtureAddressPairs,
  isUiFixtureEnabled,
} from '../../ui-fixtures/fixtureData';

/**
 * Read the public address inventory used to identify wallet-owned transaction
 * inputs and outputs. This intentionally avoids loading signing material.
 */
export async function loadWalletPublicAddresses(
  walletId: number
): Promise<string[]> {
  if (!Number.isSafeInteger(walletId) || walletId <= 0) {
    throw new Error('A valid wallet is required to load public addresses.');
  }

  if (isUiFixtureEnabled()) {
    return getUiFixtureAddressPairs().flatMap(({ address, tokenAddress }) => [
      address,
      tokenAddress,
    ]);
  }

  const keys = await KeyManager().retrieveKeys(walletId);
  return [
    ...new Set(
      keys.flatMap((key) =>
        [key.address, key.tokenAddress].filter((address): address is string =>
          Boolean(address)
        )
      )
    ),
  ];
}
