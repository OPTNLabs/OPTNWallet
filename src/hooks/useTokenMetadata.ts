import { useState, useEffect } from 'react';
import BcmrService from '../services/BcmrService'; // Adjust path as needed

const useTokenMetadata = (categories: string[]) => {
  const [metadata, setMetadata] = useState<
    Record<string, { name: string; symbol: string; decimals: number; iconUri: string | null }>
  >({});

  useEffect(() => {
    const svc = new BcmrService();
    const missing = categories.filter((c) => !(c in metadata));
    if (missing.length === 0) return;

    (async () => {
      const newMeta: Record<string, { name: string; symbol: string; decimals: number; iconUri: string | null }> = {};
      for (const category of missing) {
        try {
          const authbase = await svc.getCategoryAuthbase(category);
          const idReg = await svc.resolveIdentityRegistry(authbase);
          const snap = svc.extractIdentity(authbase, idReg.registry);
          const iconUri = await svc.resolveIcon(authbase);
          newMeta[category] = {
            name: snap.name,
            symbol: snap.token?.symbol || '',
            decimals: snap.token?.decimals || 0,
            iconUri,
          };
        } catch (e) {
          console.error('Failed loading metadata for', category, e);
        }
      }
      setMetadata((prev) => ({ ...prev, ...newMeta }));
    })();
  }, [categories]);

  return metadata;
};

export default useTokenMetadata;