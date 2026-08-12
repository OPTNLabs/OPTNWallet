import { useEffect, useState } from 'react';
import BcmrService from '../../services/BcmrService';
import DatabaseService from '../../apis/DatabaseManager/DatabaseService';
import { logError } from '../../utils/errorHandling';
import { HomeTokenTotals } from './homeMetrics';

type UseHomeMetadataPreloadParams = {
  isInitialized: boolean;
  placeholderTokenTotals: HomeTokenTotals;
};

export function useHomeMetadataPreload({
  isInitialized,
  placeholderTokenTotals,
}: UseHomeMetadataPreloadParams) {
  const [metadataPreloaded, setMetadataPreloaded] = useState(false);

  useEffect(() => {
    if (!isInitialized) return;
    (async () => {
      try {
        const bcmr = new BcmrService();
        const categories = Object.keys(placeholderTokenTotals);
        await Promise.all(
          categories.map(async (category) => {
            const authbase = await bcmr.getCategoryAuthbase(category);
            await bcmr.resolveIdentityRegistry(authbase);
          })
        );
        setMetadataPreloaded(true);
      } catch (error) {
        logError('Home.preloadTokenMetadata', error);
      }
    })();
  }, [isInitialized, placeholderTokenTotals]);

  useEffect(() => {
    if (isInitialized && metadataPreloaded) {
      void DatabaseService().saveDatabaseToFile();
    }
  }, [isInitialized, metadataPreloaded]);
}
