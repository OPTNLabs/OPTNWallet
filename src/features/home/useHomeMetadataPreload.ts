import { useEffect, useMemo, useState } from 'react';
import DatabaseService from '../../apis/DatabaseManager/DatabaseService';
import { HomeTokenTotals } from './homeMetrics';
import {
  getCachedTokenMetadata,
  METADATA_FAILURE_TTL_MS,
  preloadTokenMetadata,
} from '../../hooks/useSharedTokenMetadata';

type UseHomeMetadataPreloadParams = {
  isInitialized: boolean;
  placeholderTokenTotals: HomeTokenTotals;
};

export function useHomeMetadataPreload({
  isInitialized,
  placeholderTokenTotals,
}: UseHomeMetadataPreloadParams) {
  const [metadataPreloaded, setMetadataPreloaded] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);
  const categories = useMemo(
    () => Object.keys(placeholderTokenTotals).sort(),
    [placeholderTokenTotals]
  );
  const categoriesKey = categories.join(',');

  useEffect(() => {
    if (!isInitialized) return;
    let cancelled = false;
    const runPreload = async () => {
      const pendingCategories = categories.filter(
        (category) => getCachedTokenMetadata(category)?.freshness !== 'fresh'
      );

      if (pendingCategories.length === 0) {
        if (cancelled) return;
        setMetadataPreloaded(true);
        return;
      }

      await preloadTokenMetadata(pendingCategories);

      if (cancelled) return;
      setMetadataPreloaded(true);
    };

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let idleId: number | undefined;
    const browserWindow = typeof window !== 'undefined' ? window : undefined;
    if (browserWindow && 'requestIdleCallback' in browserWindow) {
      idleId = browserWindow.requestIdleCallback(() => {
        void runPreload();
      });
    } else {
      timeoutId = globalThis.setTimeout(() => {
        void runPreload();
      }, 0);
    }

    const retryTimer: ReturnType<typeof setTimeout> = globalThis.setTimeout(() => {
      if (!cancelled) {
        setRetryNonce((value) => value + 1);
      }
    }, METADATA_FAILURE_TTL_MS);

    return () => {
      cancelled = true;
      if (
        idleId !== undefined &&
        browserWindow &&
        'cancelIdleCallback' in browserWindow
      ) {
        browserWindow.cancelIdleCallback(idleId);
      }
      if (timeoutId !== undefined && browserWindow) {
        globalThis.clearTimeout(timeoutId);
      }
      if (retryTimer !== undefined && browserWindow) {
        globalThis.clearTimeout(retryTimer);
      }
    };
  }, [categories, categoriesKey, isInitialized, retryNonce]);

  useEffect(() => {
    if (isInitialized && metadataPreloaded) {
      DatabaseService().scheduleDatabaseSave();
    }
  }, [isInitialized, metadataPreloaded]);
}
