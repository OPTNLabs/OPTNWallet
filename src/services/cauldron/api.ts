import { Network } from '../../redux/networkSlice';
import { getCauldronApiBaseUrl } from './config';
import type {
  CauldronActivePoolRecord,
  CauldronAggregatedApyResponse,
  CauldronPoolHistoryResponse,
  CauldronTokenListItemCached,
} from './types';

export type CauldronActivePoolRow =
  | CauldronActivePoolRecord
  | Record<string, unknown>;
export type CauldronTokenRow =
  | CauldronTokenListItemCached
  | Record<string, unknown>;

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const text = await response.text().catch(() => '');
  if (!response.ok) {
    throw new Error(
      `Cauldron API request failed with HTTP ${response.status}${
        text ? `: ${text.slice(0, 160)}` : ''
      }`
    );
  }
  if (!text.trim()) {
    throw new Error('Cauldron API returned an empty response');
  }
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? `Cauldron API returned non-JSON content: ${error.message}`
        : 'Cauldron API returned non-JSON content'
    );
  }
}

const CAULDRON_API_CACHE_TTL_MS = 5_000;
const CAULDRON_API_CACHE_MAX_ENTRIES = 32;

type CachedCauldronRequest = {
  expiresAt: number;
  promise: Promise<unknown>;
};

const cauldronRequestCache = new Map<string, CachedCauldronRequest>();

function pruneCauldronApiCache(): void {
  const now = Date.now();
  for (const [key, entry] of cauldronRequestCache) {
    if (entry.expiresAt <= now) {
      cauldronRequestCache.delete(key);
    }
  }

  while (cauldronRequestCache.size > CAULDRON_API_CACHE_MAX_ENTRIES) {
    const oldestKey = cauldronRequestCache.keys().next().value;
    if (typeof oldestKey !== 'string') break;
    cauldronRequestCache.delete(oldestKey);
  }
}

function fetchJsonCached<T>(key: string, url: string): Promise<T> {
  const cached = cauldronRequestCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    cauldronRequestCache.delete(key);
    cauldronRequestCache.set(key, cached);
    return cached.promise as Promise<T>;
  }

  let promise: Promise<T>;
  promise = fetchJson<T>(url).catch((error) => {
    const current = cauldronRequestCache.get(key);
    if (current?.promise === promise) {
      cauldronRequestCache.delete(key);
    }
    throw error;
  });

  cauldronRequestCache.set(key, {
    expiresAt: Date.now() + CAULDRON_API_CACHE_TTL_MS,
    promise,
  });
  pruneCauldronApiCache();
  return promise;
}

export function clearCauldronApiCache(): void {
  cauldronRequestCache.clear();
}

export class CauldronApiClient {
  constructor(
    readonly network: Network,
    readonly baseUrl = getCauldronApiBaseUrl(network)
  ) {}

  async listActivePools(
    params: {
      tokenId?: string;
      publicKeyHash?: string;
    } = {}
  ): Promise<CauldronActivePoolRow[]> {
    const search = new URLSearchParams();
    if (params.tokenId) search.set('token', params.tokenId);
    if (params.publicKeyHash) search.set('pkh', params.publicKeyHash);

    if (!search.toString()) {
      throw new Error(
        'Cauldron active-pools lookup requires a token id or public key hash'
      );
    }

    const url = `${this.baseUrl}/pool/active?${search.toString()}`;
    const payload = await fetchJsonCached<unknown>(url, url);
    if (Array.isArray(payload)) return payload as CauldronActivePoolRow[];
    if (payload && typeof payload === 'object') {
      const pools =
        (payload as { active?: unknown; pools?: unknown }).active ??
        (payload as { active?: unknown; pools?: unknown }).pools;
      if (Array.isArray(pools)) return pools as CauldronActivePoolRow[];
    }
    throw new Error('Unexpected Cauldron active-pools response shape');
  }

  async listCachedTokens(
    params: {
      limit?: number;
      offset?: number;
      by?: 'score' | 'volume' | 'tvl' | 'name' | 'symbol';
      order?: 'asc' | 'desc';
    } = {}
  ): Promise<CauldronTokenRow[]> {
    const search = new URLSearchParams();
    search.set('limit', String(params.limit ?? 500));
    search.set('offset', String(params.offset ?? 0));
    search.set('by', params.by ?? 'score');
    search.set('order', params.order ?? 'desc');

    const url = `${this.baseUrl}/tokens/list_cached?${search.toString()}`;
    const payload = await fetchJsonCached<unknown>(url, url);
    if (Array.isArray(payload)) return payload as CauldronTokenRow[];
    if (payload && typeof payload === 'object') {
      const tokens = (payload as { tokens?: unknown }).tokens;
      if (Array.isArray(tokens)) return tokens as CauldronTokenRow[];
    }
    throw new Error('Unexpected Cauldron token-list response shape');
  }

  async listCachedTokensByIds(tokenIds: string[]): Promise<CauldronTokenRow[]> {
    if (tokenIds.length === 0) return [];

    const search = new URLSearchParams({
      ids: tokenIds.join(','),
    });
    const url = `${this.baseUrl}/tokens/list_cached_by_ids?${search.toString()}`;
    const payload = await fetchJsonCached<unknown>(url, url);
    if (Array.isArray(payload)) return payload as CauldronTokenRow[];
    if (payload && typeof payload === 'object') {
      const tokens = (payload as { tokens?: unknown }).tokens;
      if (Array.isArray(tokens)) return tokens as CauldronTokenRow[];
    }
    throw new Error('Unexpected Cauldron token-list-by-ids response shape');
  }

  async getCurrentPrice(tokenId: string): Promise<Record<string, unknown>> {
    const url = `${this.baseUrl}/price/${encodeURIComponent(tokenId)}/current`;
    return fetchJsonCached<Record<string, unknown>>(url, url);
  }

  async getPoolHistory(
    poolId: string,
    startTimestamp?: number
  ): Promise<CauldronPoolHistoryResponse> {
    const search = new URLSearchParams();
    if (typeof startTimestamp === 'number' && Number.isFinite(startTimestamp)) {
      search.set('start', String(Math.trunc(startTimestamp)));
    }

    const url = `${this.baseUrl}/pool/history/${encodeURIComponent(poolId)}${
      search.size > 0 ? `?${search.toString()}` : ''
    }`;
    return fetchJsonCached<CauldronPoolHistoryResponse>(url, url);
  }

  async getAggregatedApy(params: {
    tokenId?: string;
    publicKeyHash?: string;
    poolId?: string;
    startTimestamp?: number;
    endTimestamp?: number;
  }): Promise<CauldronAggregatedApyResponse> {
    const search = new URLSearchParams();
    if (params.tokenId) search.set('token', params.tokenId);
    if (params.publicKeyHash) search.set('pkh', params.publicKeyHash);
    if (params.poolId) search.set('pool', params.poolId);
    if (
      typeof params.startTimestamp === 'number' &&
      Number.isFinite(params.startTimestamp)
    ) {
      search.set('start', String(Math.trunc(params.startTimestamp)));
    }
    if (
      typeof params.endTimestamp === 'number' &&
      Number.isFinite(params.endTimestamp)
    ) {
      search.set('end', String(Math.trunc(params.endTimestamp)));
    }

    const url = `${this.baseUrl}/pool/aggregated_apy?${search.toString()}`;
    return fetchJsonCached<CauldronAggregatedApyResponse>(url, url);
  }
}
