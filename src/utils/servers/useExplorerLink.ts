/**
 * The one way a screen asks for an explorer link.
 *
 * Transaction links use the selected explorer and current network directly.
 * Address lookups continue to follow the chain-source privacy policy.
 *
 * `url` is `null` only when a selected template or value is invalid.
 */

import { useMemo } from 'react';
import { useSelector } from 'react-redux';
import { buildAddressUrl, buildTxUrl, explorerPolicyFor } from './explorers';
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
    'Explorer links are unavailable because this wallet is restricted to your own infrastructure. Choose an allowed explorer in Settings → Explorer, or change the network privacy policy.',
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
    const resolved = explorerPolicyFor(policy);
    return {
      tx,
      address,
      reason: REASONS[resolved] ?? null,
    };
  }, [choice, policy]);
}
