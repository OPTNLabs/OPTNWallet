/**
 * The one way a screen asks for an explorer link.
 *
 * Every surface that wants to open a transaction needs two things it should
 * not each fetch for itself: which explorer the holder chose, and whether the
 * current chain policy permits a public one at all. Screens that reached for
 * the URL builder directly used to supply neither — two of them hardcoded the
 * default preset, ignoring the holder's choice, and none of them knew about
 * the policy, so "own infrastructure only" stopped at the chain layer and an
 * explorer link walked straight past it.
 *
 * `url` is `null` when there is no link to offer. That is a real answer, not a
 * failure: under a private policy with no explorer of the holder's own
 * configured, no link is the correct outcome, and `reason` says so in words a
 * holder can act on.
 */

import { useMemo } from 'react';
import { useSelector } from 'react-redux';
import {
  buildAddressUrl,
  buildTxUrl,
  explorerPolicyFor,
} from './explorers';
import {
  selectChainPolicy,
  selectExplorerChoice,
} from '../../state/slices/preferencesSlice';
import type { Network } from '../../state/slices/networkSlice';

export type ExplorerLinks = {
  tx: (network: Network, txid: string) => string | null;
  address: (network: Network, address: string) => string | null;
  /** Why links are unavailable, or `null` when they are available. */
  reason: string | null;
};

const REASONS: Record<string, string> = {
  'user-owned-only':
    'Explorer links are off because this wallet is set to use only your own infrastructure. Add your own explorer in Settings → Servers to turn them back on.',
  disabled: 'Explorer links are turned off.',
};

export function useExplorerLink(): ExplorerLinks {
  const choice = useSelector(selectExplorerChoice);
  const policy = useSelector(selectChainPolicy);

  return useMemo(() => {
    const tx = (network: Network, txid: string) =>
      buildTxUrl(choice, network, txid, policy);
    const address = (network: Network, value: string) =>
      buildAddressUrl(choice, network, value, policy);
    // A custom explorer is the holder's own, so it survives every policy that
    // permits any link at all. Probing with a sample txid asks the core the
    // same question the real call will ask, rather than restating its rule.
    const available = tx('mainnet' as Network, 'a'.repeat(64)) !== null;
    const resolved = explorerPolicyFor(policy);
    return {
      tx,
      address,
      reason: available ? null : (REASONS[resolved] ?? null),
    };
  }, [choice, policy]);
}
