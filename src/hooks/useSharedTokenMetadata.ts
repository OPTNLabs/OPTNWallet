import { useEffect, useMemo, useState } from 'react';
import type { IdentitySnapshot } from '@bitauth/libauth';
import BcmrService from '../services/BcmrService';
import { resolveIpfsGatewayUrl } from '../utils/ipfs';

export type SharedTokenMetadata = {
  status: 'loading' | 'ready' | 'error';
  name: string;
  symbol: string;
  decimals: number;
  iconUri: string | null;
  snapshot: IdentitySnapshot | null;
  error?: string;
};

const bcmr = new BcmrService();
const metadataCache = new Map<string, SharedTokenMetadata>();
const metadataFailureCache = new Map<
  string,
  { state: SharedTokenMetadata; ts: number }
>();
const inflightMetadata = new Map<string, Promise<SharedTokenMetadata | null>>();
export const METADATA_FAILURE_TTL_MS = 5_000;

function buildSharedMetadata(
  category: string,
  snapshot: IdentitySnapshot,
  iconUri: string | null
): SharedTokenMetadata {
  const snapshotIcon = String(snapshot.uris?.icon ?? '').trim();
  const fallbackIconUri = snapshotIcon
    ? resolveIpfsGatewayUrl(snapshotIcon) ??
      (snapshotIcon.startsWith('http://') ||
      snapshotIcon.startsWith('https://') ||
      snapshotIcon.startsWith('data:') ||
      snapshotIcon.startsWith('blob:') ||
      snapshotIcon.startsWith('/')
        ? snapshotIcon
        : null)
    : null;

  return {
    status: 'ready',
    name: snapshot.name || category,
    symbol: snapshot.token?.symbol || '',
    decimals: snapshot.token?.decimals ?? 0,
    iconUri: iconUri || fallbackIconUri,
    snapshot,
  };
}

function getRecentFailure(category: string): SharedTokenMetadata | undefined {
  const failure = metadataFailureCache.get(category);
  if (!failure) return undefined;
  if (Date.now() - failure.ts > METADATA_FAILURE_TTL_MS) {
    metadataFailureCache.delete(category);
    return undefined;
  }
  return failure.state;
}

function getFailureRetryDelayMs(category: string): number | undefined {
  const failure = metadataFailureCache.get(category);
  if (!failure) return undefined;
  const age = Date.now() - failure.ts;
  if (age >= METADATA_FAILURE_TTL_MS) {
    metadataFailureCache.delete(category);
    return undefined;
  }
  return METADATA_FAILURE_TTL_MS - age;
}

async function loadTokenMetadata(
  category: string,
  options?: { force?: boolean }
): Promise<SharedTokenMetadata | null> {
  const normalized = String(category ?? '').trim();
  if (!normalized) return null;

  const cached = metadataCache.get(normalized);
  if (cached) return cached;
  const recentFailure = options?.force ? undefined : getRecentFailure(normalized);
  if (recentFailure) return recentFailure;

  const inflight = inflightMetadata.get(normalized);
  if (inflight) return inflight;

  const request = (async () => {
    try {
      const persistedSnapshot = await bcmr.getSnapshot(normalized);
      if (persistedSnapshot) {
        let persistedIconUri: string | null = null;
        try {
          const persistedAuthbase = await bcmr.getCategoryAuthbase(normalized);
          persistedIconUri = await bcmr.resolveIcon(
            persistedAuthbase,
            undefined,
            normalized
          );
        } catch {
          // Keep cached metadata fast-path even if icon refresh fails.
        }

        const persisted = buildSharedMetadata(
          normalized,
          persistedSnapshot,
          persistedIconUri
        );
        metadataCache.set(normalized, persisted);
        metadataFailureCache.delete(normalized);
        return persisted;
      }

      const authbase = await bcmr.getCategoryAuthbase(normalized);
      let registry = await bcmr.resolveIdentityRegistry(authbase);
      let snapshot: IdentitySnapshot;

      try {
        snapshot = bcmr.extractIdentityByCategory(normalized, registry.registry);
      } catch (error) {
        const fallbackRegistry = await bcmr.resolveCategorySpecificRegistry(
          normalized
        );
        if (!fallbackRegistry) {
          throw error;
        }
        registry = fallbackRegistry;
        snapshot = bcmr.extractIdentityByCategory(normalized, registry.registry);
      }

      const iconUri = await bcmr.resolveIcon(authbase, undefined, normalized);
      const shared = buildSharedMetadata(normalized, snapshot, iconUri);
      metadataCache.set(normalized, shared);
      metadataFailureCache.delete(normalized);
      return shared;
    } catch (error) {
      const failure: SharedTokenMetadata = {
        status: 'error',
        name: normalized,
        symbol: '',
        decimals: 0,
        iconUri: null,
        snapshot: null,
        error:
          error instanceof Error ? error.message : 'Failed to load BCMR metadata.',
      };
      metadataFailureCache.set(normalized, { state: failure, ts: Date.now() });
      return failure;
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
  const normalized = String(category ?? '').trim();
  return metadataCache.get(normalized) ?? getRecentFailure(normalized);
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
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const next: Record<string, SharedTokenMetadata> = {};
    const missing: string[] = [];
    let retryAfterMs: number | undefined;

    for (const category of normalizedCategories) {
      const cached = metadataCache.get(category) ?? getRecentFailure(category);
      if (cached) {
        next[category] = cached;
        if (cached.status === 'error') {
          const delay = getFailureRetryDelayMs(category);
          if (delay !== undefined) {
            retryAfterMs =
              retryAfterMs === undefined ? delay : Math.min(retryAfterMs, delay);
          }
        }
      } else {
        next[category] = {
          status: 'loading',
          name: category,
          symbol: '',
          decimals: 0,
          iconUri: null,
          snapshot: null,
        };
        missing.push(category);
      }
    }

    if (Object.keys(next).length > 0) {
      setMetadata((prev) => ({ ...prev, ...next }));
    }

    let retryTimer: number | undefined;
    if (missing.length === 0) {
      if (retryAfterMs !== undefined) {
        retryTimer = window.setTimeout(() => {
          setRetryNonce((value) => value + 1);
        }, retryAfterMs);
      }
      return () => {
        cancelled = true;
        if (retryTimer !== undefined) {
          window.clearTimeout(retryTimer);
        }
      };
    }

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
      if (retryTimer !== undefined) {
        window.clearTimeout(retryTimer);
      }
    };
  }, [normalizedCategories, retryNonce]);

  return metadata;
}
