// Shared per-network unit label for the desktop build.
//
// Mainnet holds real BCH; every test network holds test coins, so they read
// "tBCH". `Network` currently has only MAINNET/CHIPNET, so "non-mainnet ⇒ tBCH"
// automatically covers testnet3/testnet4 the moment those enum values are added.
//
// One source of truth so every desktop screen that shows a balance labels it the
// same way (upstream inlines "BCH" in ~43 places with no shared formatter; the
// desktop swaps that need a unit import this).
import { Network } from '../../state/slices/networkSlice';

export const unitFor = (network: Network): 'BCH' | 'tBCH' =>
  network === Network.MAINNET ? 'BCH' : 'tBCH';
