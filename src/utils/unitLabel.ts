import { Network } from '../state/slices/networkSlice';
import { networkProfile } from './networkProfile';

/** The native BCH display unit for the active network. */
export const unitFor = (network: Network): 'BCH' | 'tBCH' =>
  networkProfile(network).unit;
