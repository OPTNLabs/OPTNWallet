import { useMemo } from 'react';
import useSharedTokenMetadata from '../../hooks/useSharedTokenMetadata';
import { CategorySummary, TokenMetaMap } from './types';

export function useTokenMetadata(categories: CategorySummary[]) {
  const categoryNames = useMemo(
    () => categories.map((c) => c.category),
    [categories]
  );
  return useSharedTokenMetadata(categoryNames) as TokenMetaMap;
}
