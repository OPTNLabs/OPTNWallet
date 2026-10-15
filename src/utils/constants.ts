import { Network } from '../state/slices/networkSlice';
import { cashAddressPrefix, type CashAddressPrefix } from './networkProfile';

/** CashAddr prefix keyed by `Network` value, read from the network profiles. */
export const PREFIX: Readonly<Record<Network, CashAddressPrefix>> = {
  [Network.MAINNET]: cashAddressPrefix(Network.MAINNET),
  [Network.TESTNET3]: cashAddressPrefix(Network.TESTNET3),
  [Network.TESTNET4]: cashAddressPrefix(Network.TESTNET4),
  [Network.CHIPNET]: cashAddressPrefix(Network.CHIPNET),
};

export enum COIN_TYPE {
  bitcoincash = 145,
  testnet = 1,
  legacy = 0,
}

export const INTERVAL = 300 * 1000; // 5-minute interval

export const SATSINBITCOIN = 100000000;

export const DUST = 546;

export const TOKEN_OUTPUT_SATS = 1000;
