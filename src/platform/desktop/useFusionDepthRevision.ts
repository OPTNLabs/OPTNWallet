// React re-render trigger when fuse depth / fusion txid labels change.
// Depth lives in localStorage (shared across windows) but React does not
// subscribe to storage by default — without this, server Fusion completed
// successfully while Home / coin control still showed no "Fused" badge.

import { useEffect, useState } from 'react';

import { FUSION_DEPTH_CHANGED_EVENT } from './fusionCoinDepth';

/**
 * Increments whenever this wallet's fusion depth or CoinJoin txid set changes.
 * Pass the value into a useMemo dependency (or just read it) so Fused badges
 * recompute after Auto/manual server or P2P rounds.
 */
export function useFusionDepthRevision(walletId: number): number {
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!Number.isInteger(walletId) || walletId <= 0) return;

    const onChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ walletId?: number }>).detail;
      if (
        detail &&
        typeof detail.walletId === 'number' &&
        detail.walletId !== walletId
      ) {
        return;
      }
      setRevision((n) => n + 1);
    };

    const onStorage = (event: StorageEvent) => {
      if (!event.key) return;
      if (
        event.key.includes(`optn-fusion-`) &&
        event.key.includes(String(walletId))
      ) {
        setRevision((n) => n + 1);
      }
    };

    window.addEventListener(FUSION_DEPTH_CHANGED_EVENT, onChanged);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(FUSION_DEPTH_CHANGED_EVENT, onChanged);
      window.removeEventListener('storage', onStorage);
    };
  }, [walletId]);

  return revision;
}
