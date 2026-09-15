import { Network } from '../state/slices/networkSlice';

/** The native BCH display unit for the active network. */
export const unitFor = (network: Network): 'BCH' | 'tBCH' =>
  network === Network.MAINNET ? 'BCH' : 'tBCH';
