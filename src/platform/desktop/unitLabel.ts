// Compatibility export for desktop callers.
//
// Mainnet holds real BCH; every test network holds test coins, so they read
// "tBCH". `Network` currently has only MAINNET/CHIPNET, so "non-mainnet ⇒ tBCH"
// automatically covers testnet3/testnet4 the moment those enum values are added.
//
// The implementation is shared with mobile so network labels cannot drift
// between builds.
// Keep this path working for desktop-only imports while sharing the behavior
// with the mobile Home implementation.
export { unitFor } from '../../utils/unitLabel';
