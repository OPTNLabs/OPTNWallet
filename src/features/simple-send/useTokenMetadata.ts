import { useMemo } from 'react';
import useSharedTokenMetadata from '../../hooks/useSharedTokenMetadata';
import { CategorySummary, TokenMetaMap } from './types';

export function useTokenMetadata(categories: CategorySummary[]) {
  const categoryNames = useMemo(
    () => categories.map((c) => c.category),
    [categories]
  );
  const shared = useSharedTokenMetadata(categoryNames);
  return useMemo(
    () =>
      Object.fromEntries(
        Object.entries(shared).map(([category, meta]) => [
          category,
          {
            name: meta.name,
            symbol: meta.symbol,
            decimals: meta.decimals,
          },
        ])
      ) as TokenMetaMap,
    [shared]
  );
}
