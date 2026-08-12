import type { IdentitySnapshot } from '@bitauth/libauth';

export type BcmrSnapshot = IdentitySnapshot & {
  lastFetch?: string | null;
  registryUri?: string | null;
  registryHash?: string | null;
};

export type BcmrMetadataFreshness =
  | 'fresh'
  | 'cached'
  | 'refreshing'
  | 'offline'
  | 'unavailable';

export type BcmrTokenMetadataState = {
  status: 'loading' | 'ready' | 'error';
  freshness: BcmrMetadataFreshness;
  name: string;
  symbol: string;
  decimals: number;
  iconUri: string | null;
  snapshot: BcmrSnapshot | null;
  error?: string;
  lastFetch?: string | null;
  registryUri?: string | null;
  registryHash?: string | null;
  isRefreshing: boolean;
};

export function getBcmrMetadataStatusLabel(
  metadata?: Pick<
    BcmrTokenMetadataState,
    'status' | 'freshness' | 'isRefreshing' | 'snapshot'
  > | null
): string {
  if (!metadata) return 'Unavailable';

  if (metadata.status === 'loading' || metadata.isRefreshing) {
    return 'Refreshing';
  }

  switch (metadata.freshness) {
    case 'fresh':
      return 'Fresh';
    case 'cached':
      return 'Cached';
    case 'refreshing':
      return 'Refreshing';
    case 'offline':
      return 'Offline';
    case 'unavailable':
      return metadata.snapshot ? 'Cached' : 'Unavailable';
    default:
      return metadata.snapshot ? 'Cached' : 'Unavailable';
  }
}

export function getBcmrMetadataStatusTone(
  metadata?: Pick<
    BcmrTokenMetadataState,
    'status' | 'freshness' | 'isRefreshing' | 'snapshot'
  > | null
): 'accent' | 'muted' | 'warning' | 'danger' {
  const label = getBcmrMetadataStatusLabel(metadata);
  switch (label) {
    case 'Fresh':
    case 'Refreshing':
      return 'accent';
    case 'Offline':
      return 'warning';
    case 'Unavailable':
      return 'danger';
    case 'Cached':
    default:
      return 'muted';
  }
}
