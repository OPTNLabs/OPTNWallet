import { Network } from '../../../state/slices/networkSlice';

export type MerchantStablecoin = {
  tokenId: string;
  symbol: string;
  name: string;
  decimals: number;
};

const MAINNET_MERCHANT_STABLECOINS: MerchantStablecoin[] = [
  {
    tokenId: '2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544',
    symbol: 'PUSD',
    name: 'ParyonUSD',
    decimals: 2,
  },
  {
    tokenId: 'b38a33f750f84c5c169a6f23cb873e6e79605021585d4f3408789689ed87f366',
    symbol: 'MUSD',
    name: 'Moria USD',
    decimals: 2,
  },
];

const CHIPNET_MERCHANT_STABLECOINS: MerchantStablecoin[] = [
  {
    tokenId: 'dfe50223c8d5cba8dcef8dff6d92b61deb88a8ba44947367f2b746487b56039b',
    symbol: 'PUSD',
    name: 'ParyonUSD',
    decimals: 2,
  },
];

export function getMerchantStablecoins(network: Network): MerchantStablecoin[] {
  return network === Network.MAINNET
    ? MAINNET_MERCHANT_STABLECOINS
    : CHIPNET_MERCHANT_STABLECOINS;
}
export function getDefaultMerchantStablecoin(
  network: Network
): MerchantStablecoin | null {
  return getMerchantStablecoins(network)[0] ?? null;
}

export function isMerchantStablecoin(
  network: Network,
  tokenId: string
): boolean {
  const normalizedTokenId = tokenId.trim().toLowerCase();
  if (!normalizedTokenId) return false;
  return getMerchantStablecoins(network).some(
    (stablecoin) => stablecoin.tokenId === normalizedTokenId
  );
}
