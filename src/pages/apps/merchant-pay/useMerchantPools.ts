import { useCallback, useEffect, useState } from 'react';

import type { CauldronApiClient } from '../../../services/cauldron/api';
import { fetchNormalizedCauldronPools } from '../../../services/cauldron/planner';
import type { CauldronPool } from '../../../services/cauldron/types';
import type { Network } from '../../../state/slices/networkSlice';

export function useMerchantPools({
  network,
  apiClient,
  tokenId,
}: {
  network: Network;
  apiClient: CauldronApiClient;
  tokenId?: string;
}) {
  const [pools, setPools] = useState<CauldronPool[]>([]);
  const [loading, setLoading] = useState(Boolean(tokenId));
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;

    if (!tokenId) {
      setPools([]);
      setError(null);
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }

    setLoading(true);
    setError(null);
    setPools([]);

    void (async () => {
      try {
        const nextPools = await fetchNormalizedCauldronPools(
          network,
          apiClient,
          tokenId
        );
        if (cancelled) return;
        setPools(nextPools);
      } catch {
        if (cancelled) return;
        setPools([]);
        setError(
          'Unable to load merchant pools right now. Try again in a moment.'
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [apiClient, attempt, network, tokenId]);

  const retry = useCallback(() => {
    setLoading(true);
    setError(null);
    setAttempt((current) => current + 1);
  }, []);

  return { pools, setPools, loading, error, retry };
}
