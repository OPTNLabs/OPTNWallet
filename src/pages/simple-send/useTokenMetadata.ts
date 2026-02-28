import { useEffect, useMemo, useState } from 'react';
import BcmrService from '../../services/BcmrService';
import { CategorySummary, TokenMetaMap } from './types';

export function useTokenMetadata(categories: CategorySummary[]) {
  const [tokenMeta, setTokenMeta] = useState<TokenMetaMap>({});
  const bcmr = useMemo(() => new BcmrService(), []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!Array.isArray(categories) || categories.length === 0) return;

      const uniques = Array.from(new Set(categories.map((c) => c.category)));
      const acc: [string, { name: string; symbol: string; decimals: number }][] =
        [];

      for (const cat of uniques) {
        try {
          let snap = await bcmr.getSnapshot(cat);
          if (!snap) {
            try {
              await bcmr.resolveIdentityRegistry(cat);
              snap = await bcmr.getSnapshot(cat);
            } catch {
              // ignore individual failures
            }
          }
          if (snap) {
            acc.push([
              cat,
              {
                name: snap.name || '',
                symbol: snap.token?.symbol || '',
                decimals: snap.token?.decimals ?? 0,
              },
            ]);
          }
        } catch {
          // ignore category
        }
      }

      if (!cancelled && acc.length > 0) {
        setTokenMeta((prev) => ({ ...prev, ...Object.fromEntries(acc) }));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [categories, bcmr]);

  return tokenMeta;
}
