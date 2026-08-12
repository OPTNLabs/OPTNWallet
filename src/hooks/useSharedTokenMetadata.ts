import { useEffect, useMemo, useState } from 'react';
import type { IdentitySnapshot } from '@bitauth/libauth';
import BcmrService from '../services/BcmrService';

export type SharedTokenMetadata = {
  name: string;
  symbol: string;
  decimals: number;
  iconUri: string | null;
  snapshot: IdentitySnapshot | null;
};

const bcmr = new BcmrService();
const metadataCache = new Map<string, SharedTokenMetadata>();
const inflightMetadata = new Map<string, Promise<SharedTokenMetadata | null>>();

async function loadTokenMetadata(
  category: string
): Promise<SharedTokenMetadata | null> {
  const normalized = String(category ?? '').trim();
  if (!normalized) return null;

  const cached = metadataCache.get(normalized);
  if (cached) return cached;

  const inflight = inflightMetadata.get(normalized);
  if (inflight) return inflight;

  const request = (async () => {
    try {
      const authbase = await bcmr.getCategoryAuthbase(normalized);
      const registry = await bcmr.resolveIdentityRegistry(authbase);
      const snapshot = bcmr.extractIdentity(authbase, registry.registry);
      const iconUri = await bcmr.resolveIcon(authbase);
      const shared: SharedTokenMetadata = {
        name: snapshot.name || normalized,
        symbol: snapshot.token?.symbol || '',
        decimals: snapshot.token?.decimals ?? 0,
        iconUri,
        snapshot,
      };
      metadataCache.set(normalized, shared);
      return shared;
    } catch {
      return null;
    } finally {
      inflightMetadata.delete(normalized);
    }
  })();

  inflightMetadata.set(normalized, request);
  return request;
}

export function getCachedTokenMetadata(
  category: string
): SharedTokenMetadata | undefined {
  return metadataCache.get(String(category ?? '').trim());
}

export async function preloadTokenMetadata(categories: string[]): Promise<void> {
  const unique = Array.from(
    new Set(categories.map((category) => String(category ?? '').trim()).filter(Boolean))
  );
  await Promise.all(unique.map((category) => loadTokenMetadata(category)));
}

export default function useSharedTokenMetadata(categories: string[]) {
  const categoriesKey = categories.join(',');
  const normalizedCategories = useMemo(
    () =>
      Array.from(
        new Set(categories.map((category) => String(category ?? '').trim()).filter(Boolean))
      ),
    [categoriesKey]
  );
  const [metadata, setMetadata] = useState<Record<string, SharedTokenMetadata>>(
    {}
  );

  useEffect(() => {
    let cancelled = false;
    const next: Record<string, SharedTokenMetadata> = {};
    const missing: string[] = [];

    for (const category of normalizedCategories) {
      const cached = metadataCache.get(category);
      if (cached) {
        next[category] = cached;
      } else if (cached === undefined) {
        missing.push(category);
      }
    }

    if (Object.keys(next).length > 0) {
      setMetadata((prev) => ({ ...prev, ...next }));
    }

    if (missing.length === 0) return () => undefined;

    void (async () => {
      const loaded = await Promise.all(
        missing.map(async (category) => ({
          category,
          metadata: await loadTokenMetadata(category),
        }))
      );

      if (cancelled) return;

      const resolved: Record<string, SharedTokenMetadata> = {};
      for (const item of loaded) {
        if (item.metadata) {
          resolved[item.category] = item.metadata;
        }
      }

      if (Object.keys(resolved).length > 0) {
        setMetadata((prev) => ({ ...prev, ...resolved }));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [normalizedCategories]);

  return metadata;
}
