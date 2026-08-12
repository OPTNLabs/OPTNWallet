import { useEffect, useMemo, useRef, useState } from 'react';
import DatabaseService from '../../apis/DatabaseManager/DatabaseService';
import { HomeTokenTotals } from './homeMetrics';
import { preloadTokenMetadata } from '../../hooks/useSharedTokenMetadata';

type UseHomeMetadataPreloadParams = {
  isInitialized: boolean;
  placeholderTokenTotals: HomeTokenTotals;
};

export function useHomeMetadataPreload({
  isInitialized,
  placeholderTokenTotals,
}: UseHomeMetadataPreloadParams) {
  const [metadataPreloaded, setMetadataPreloaded] = useState(false);
  const attemptedCategoriesRef = useRef(new Set<string>());
  const categories = useMemo(
    () => Object.keys(placeholderTokenTotals).sort(),
    [placeholderTokenTotals]
  );
  const categoriesKey = categories.join(',');

  useEffect(() => {
    if (!isInitialized) return;
    (async () => {
      const pendingCategories = categories.filter((category) => {
        if (attemptedCategoriesRef.current.has(category)) return false;
        attemptedCategoriesRef.current.add(category);
        return true;
      });

      if (pendingCategories.length === 0) {
        setMetadataPreloaded(true);
        return;
      }

      await preloadTokenMetadata(pendingCategories);

      setMetadataPreloaded(true);
    })();
  }, [categories, categoriesKey, isInitialized]);

  useEffect(() => {
    if (isInitialized && metadataPreloaded) {
      DatabaseService().scheduleDatabaseSave();
    }
  }, [isInitialized, metadataPreloaded]);
}
