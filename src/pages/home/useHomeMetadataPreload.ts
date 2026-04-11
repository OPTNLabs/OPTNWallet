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
        (category) => getCachedTokenMetadata(category)?.status !== 'ready'
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

    let timeoutId: number | undefined;
    let idleId: number | undefined;
    const browserWindow = typeof window !== 'undefined' ? window : undefined;
    if (browserWindow && 'requestIdleCallback' in browserWindow) {
      idleId = browserWindow.requestIdleCallback(() => {
        void runPreload();
      });
    } else {
      timeoutId = browserWindow?.setTimeout(() => {
        void runPreload();
      }, 0);
    }

    const retryTimer = browserWindow?.setTimeout(() => {
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
        browserWindow.clearTimeout(timeoutId);
      }
      if (retryTimer !== undefined && browserWindow) {
        browserWindow.clearTimeout(retryTimer);
      }
    };
  }, [categories, categoriesKey, isInitialized, retryNonce]);

  useEffect(() => {
    if (isInitialized && metadataPreloaded) {
      DatabaseService().scheduleDatabaseSave();
    }
  }, [isInitialized, metadataPreloaded]);
}
