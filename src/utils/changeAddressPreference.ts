import KeyService from '../services/KeyService';

type WalletAddressRow = {
  address: string;
  tokenAddress: string;
};

type WalletKeyRow = {
  address: string;
  accountIndex: number;
  changeIndex: number;
  addressIndex: number;
};

export function getLegacyDefaultChangeAddress(
  addresses: WalletAddressRow[]
): string {
  return addresses[0]?.address || '';
}

export async function getPreferredBchChangeAddress(
  walletId: number,
  addresses: WalletAddressRow[]
): Promise<string> {
  const keys = (await KeyService.retrieveKeys(walletId)) as WalletKeyRow[];
  const sortedKeys = [...keys].sort((a, b) => {
    if (a.accountIndex !== b.accountIndex) {
      return a.accountIndex - b.accountIndex;
    }
    if (a.changeIndex !== b.changeIndex) {
      return a.changeIndex - b.changeIndex;
    }
    return a.addressIndex - b.addressIndex;
  });

  const firstInternal = sortedKeys.find((key) => key.changeIndex === 1)?.address;
  return firstInternal || getLegacyDefaultChangeAddress(addresses);
}
