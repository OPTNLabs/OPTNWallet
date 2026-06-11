import { useEffect, useMemo, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import BcmrService from '../services/BcmrService';
import { resolveIpfsGatewayUrl } from '../utils/ipfs';
import type {
  BcmrSnapshot,
  BcmrTokenMetadataState,
  BcmrMetadataFreshness,
} from '../types/bcmr';

export type SharedTokenMetadata = BcmrTokenMetadataState;

const bcmr = new BcmrService();
const metadataCache = new Map<string, SharedTokenMetadata>();
const metadataFailureCache = new Map<
  string,
  { state: SharedTokenMetadata; ts: number }
>();
const inflightMetadata = new Map<string, Promise<SharedTokenMetadata | null>>();
export const METADATA_FAILURE_TTL_MS = 5_000;

function isWebRuntime(): boolean {
  return Capacitor.getPlatform() === 'web';
}

function normalizeCategory(category: string): string {
  return String(category ?? '').trim().toLowerCase();
}

function getBrowserOnlineState(): boolean | null {
  if (typeof navigator === 'undefined') return null;
  return navigator.onLine;
}

function buildSharedMetadata(
  category: string,
  snapshot: BcmrSnapshot,
  iconUri: string | null,
  overrides?: Partial<
    Pick<
      SharedTokenMetadata,
      | 'status'
      | 'freshness'
      | 'error'
      | 'isRefreshing'
      | 'lastFetch'
      | 'registryUri'
      | 'registryHash'
    >
  >
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
    status: overrides?.status ?? 'ready',
    freshness: overrides?.freshness ?? 'cached',
    name: snapshot.name || category,
    symbol: snapshot.token?.symbol || '',
    decimals: snapshot.token?.decimals ?? 0,
    iconUri: iconUri || fallbackIconUri,
    snapshot,
    error: overrides?.error,
    lastFetch: overrides?.lastFetch ?? snapshot.lastFetch ?? null,
    registryUri: overrides?.registryUri ?? snapshot.registryUri ?? null,
    registryHash: overrides?.registryHash ?? snapshot.registryHash ?? null,
    isRefreshing: overrides?.isRefreshing ?? false,
  };
}

function buildLoadingMetadata(category: string): SharedTokenMetadata {
  return {
    status: 'loading',
    freshness: 'unavailable',
    name: category,
    symbol: '',
    decimals: 0,
    iconUri: null,
    snapshot: null,
    isRefreshing: false,
    lastFetch: null,
    registryUri: null,
    registryHash: null,
  };
}

function buildErrorMetadata(
  category: string,
  error: unknown
): SharedTokenMetadata {
  return {
    status: 'error',
    freshness: 'unavailable',
    name: category,
    symbol: '',
    decimals: 0,
    iconUri: null,
    snapshot: null,
    error:
      error instanceof Error ? error.message : 'Failed to load BCMR metadata.',
    isRefreshing: false,
    lastFetch: null,
    registryUri: null,
    registryHash: null,
  };
}

function markRefreshing(metadata: SharedTokenMetadata): SharedTokenMetadata {
  return {
    ...metadata,
    status: 'ready',
    freshness: 'refreshing',
    isRefreshing: true,
    error: undefined,
  };
}

function shouldRetryFailure(category: string): boolean {
  const failure = metadataFailureCache.get(category);
  if (!failure) return false;
  const age = Date.now() - failure.ts;
  if (age >= METADATA_FAILURE_TTL_MS) {
    metadataFailureCache.delete(category);
    return false;
  }
  return true;
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

async function loadCachedTokenMetadata(
  category: string
): Promise<SharedTokenMetadata | null> {
  const normalized = normalizeCategory(category);
  if (!normalized) return null;

  const persistedSnapshot = await bcmr.getSnapshot(normalized);
  if (!persistedSnapshot) return null;

  let persistedIconUri: string | null = null;
  if (!isWebRuntime()) {
    try {
      const persistedAuthbase = await bcmr.getCategoryAuthbase(normalized);
      persistedIconUri = await bcmr.resolveIcon(
        persistedAuthbase,
        undefined,
        normalized
      );
    } catch {
      // Preserve the cached metadata even when icon hydration fails.
    }
  }

  const persisted = buildSharedMetadata(
    normalized,
    persistedSnapshot,
    persistedIconUri,
    {
      freshness: 'cached',
      lastFetch: persistedSnapshot.lastFetch ?? null,
      registryUri: persistedSnapshot.registryUri ?? null,
      registryHash: persistedSnapshot.registryHash ?? null,
      isRefreshing: false,
    }
  );
  metadataCache.set(normalized, persisted);
  metadataFailureCache.delete(normalized);
  return persisted;
}

function buildUnavailableMetadata(category: string): SharedTokenMetadata {
  return {
    status: 'ready',
    freshness: 'unavailable',
    name: category,
    symbol: '',
    decimals: 0,
    iconUri: null,
    snapshot: null,
    isRefreshing: false,
    lastFetch: null,
    registryUri: null,
    registryHash: null,
  };
}

async function loadFreshTokenMetadata(
  category: string
): Promise<SharedTokenMetadata> {
  const normalized = normalizeCategory(category);
  const previous = metadataCache.get(normalized);
  const authbase = await bcmr.getCategoryAuthbase(normalized);
  let registry = await bcmr.resolveIdentityRegistry(authbase);
  let snapshot: BcmrSnapshot;

  try {
    snapshot = bcmr.extractIdentityByCategory(normalized, registry.registry);
  } catch {
    const fallbackRegistry = await bcmr.resolveCategorySpecificRegistry(
      normalized
    );
    if (!fallbackRegistry) {
      throw new Error(`No identity history for token category ${normalized}`);
    }
    registry = fallbackRegistry;
    snapshot = bcmr.extractIdentityByCategory(normalized, registry.registry);
  }

  const iconUri = await bcmr.resolveIcon(authbase, undefined, normalized);
  const freshness: BcmrMetadataFreshness =
    previous?.lastFetch && registry.lastFetch === previous.lastFetch
      ? previous.freshness === 'offline'
        ? 'offline'
        : 'cached'
      : 'fresh';
  const fresh = buildSharedMetadata(normalized, snapshot, iconUri, {
    freshness,
    lastFetch: registry.lastFetch,
    registryUri: registry.registryUri,
    registryHash: registry.registryHash,
    isRefreshing: false,
  });
  metadataCache.set(normalized, fresh);
  metadataFailureCache.delete(normalized);
  return fresh;
}

export async function resolveTokenMetadata(
  category: string,
  options?: { forceRefresh?: boolean }
): Promise<SharedTokenMetadata | null> {
  const normalized = normalizeCategory(category);
  if (!normalized) return null;

  const cached = metadataCache.get(normalized);
  if (cached && !options?.forceRefresh) {
    return cached;
  }

  if (!options?.forceRefresh && shouldRetryFailure(normalized)) {
    return metadataFailureCache.get(normalized)?.state ?? null;
  }

  const inflight = inflightMetadata.get(normalized);
  if (inflight) return inflight;

  const request = (async () => {
    try {
      if (!options?.forceRefresh) {
        const persisted = await loadCachedTokenMetadata(normalized);
        if (persisted) {
          return persisted;
        }
      }

      return await loadFreshTokenMetadata(normalized);
    } catch (error) {
      const cachedState = metadataCache.get(normalized);
      if (cachedState) {
        const offline = getBrowserOnlineState() === false;
        const fallback: SharedTokenMetadata = {
          ...cachedState,
          status: 'ready',
          freshness: offline ? 'offline' : 'cached',
          isRefreshing: false,
          error:
            error instanceof Error
              ? error.message
              : 'Failed to load BCMR metadata.',
        };
        metadataCache.set(normalized, fallback);
        return fallback;
      }

      const failure = buildErrorMetadata(normalized, error);
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
  const normalized = normalizeCategory(category);
  if (!normalized) return undefined;
  return metadataCache.get(normalized) ?? metadataFailureCache.get(normalized)?.state;
}

export async function preloadTokenMetadata(categories: string[]): Promise<void> {
  const unique = Array.from(
    new Set(categories.map((category) => normalizeCategory(category)).filter(Boolean))
  );

  if (isWebRuntime()) {
    await Promise.all(
      unique.map(async (category) => {
        await loadCachedTokenMetadata(category);
      })
    );
    return;
  }

  await Promise.all(
    unique.map(async (category) => {
      await resolveTokenMetadata(category, { forceRefresh: true });
    })
  );
}

export default function useSharedTokenMetadata(categories: string[]) {
  const normalizedCategories = useMemo(() => {
    const normalized = categories
      .map((category) => normalizeCategory(category))
      .filter(Boolean);
    return Array.from(new Set(normalized));
  }, [categories]);

  const [metadata, setMetadata] = useState<Record<string, SharedTokenMetadata>>(
    {}
  );
  const [retryNonce, setRetryNonce] = useState(0);
  const [refreshNonce, setRefreshNonce] = useState(0);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const triggerRefresh = () => {
      setRefreshNonce((value) => value + 1);
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        triggerRefresh();
      }
    };

    window.addEventListener('focus', triggerRefresh);
    window.addEventListener('online', triggerRefresh);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('focus', triggerRefresh);
      window.removeEventListener('online', triggerRefresh);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const next: Record<string, SharedTokenMetadata> = {};
    let retryAfterMs: number | undefined;
    let sawHardError = false;
    let retryTimer: number | undefined;
    // Browser mode still uses cache as a fast path, but it must not block live BCMR refreshes.
    const allowRemoteRefresh = true;

    for (const category of normalizedCategories) {
      const cached = getCachedTokenMetadata(category);

      if (cached) {
        const shouldRefresh =
          allowRemoteRefresh &&
          (refreshNonce > 0 ||
            Boolean(cached.snapshot && cached.freshness !== 'fresh'));

        next[category] = shouldRefresh ? markRefreshing(cached) : cached;

        if (cached.status === 'error') {
          const delay = getFailureRetryDelayMs(category);
          if (delay !== undefined) {
            retryAfterMs =
              retryAfterMs === undefined ? delay : Math.min(retryAfterMs, delay);
          }
        }
        continue;
      }

      next[category] = buildLoadingMetadata(category);
    }

    if (Object.keys(next).length > 0) {
      setMetadata((prev) => ({ ...prev, ...next }));
    }

    void (async () => {
      await Promise.all(
        normalizedCategories.map(async (category) => {
          let resolved = getCachedTokenMetadata(category);

          if (!resolved) {
            resolved = await resolveTokenMetadata(category);
          }

          if (!resolved || cancelled) return;

          setMetadata((prev) => ({ ...prev, [category]: resolved }));

          const shouldRefresh =
            allowRemoteRefresh &&
            (refreshNonce > 0 ||
              (retryNonce > 0 && !resolved.snapshot) ||
              Boolean(resolved.snapshot && resolved.freshness !== 'fresh'));
          if (!shouldRefresh) {
            if (resolved.status === 'error' && !resolved.snapshot) {
              sawHardError = true;
            }
            return;
          }

          setMetadata((prev) => ({
            ...prev,
            [category]: markRefreshing(resolved),
          }));

          const refreshed = await resolveTokenMetadata(category, {
            forceRefresh: true,
          });
          if (!cancelled && refreshed) {
            setMetadata((prev) => ({ ...prev, [category]: refreshed }));
          }
        })
      );

      if (cancelled) return;

      if (retryAfterMs === undefined && sawHardError) {
        retryAfterMs = METADATA_FAILURE_TTL_MS;
      }

      if (retryAfterMs !== undefined) {
        retryTimer = window.setTimeout(() => {
          setRetryNonce((value) => value + 1);
        }, retryAfterMs);
      }
    })();

    return () => {
      cancelled = true;
      if (retryTimer !== undefined) {
        window.clearTimeout(retryTimer);
      }
    };
  }, [normalizedCategories, refreshNonce, retryNonce]);

  return metadata;
}
