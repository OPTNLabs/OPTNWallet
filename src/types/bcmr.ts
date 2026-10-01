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
  /** Present only for the authenticated, wallet-scoped Rust projection. */
  identityStatus?: 'verified' | 'stale' | 'unpublished' | 'unresolved';
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
    'status' | 'freshness' | 'isRefreshing' | 'snapshot' | 'identityStatus'
  > | null
): string {
  if (!metadata) return 'Unavailable';

  if (metadata.identityStatus) {
    switch (metadata.identityStatus) {
      case 'verified':
        return 'Verified';
      case 'stale':
        return 'Last known';
      case 'unpublished':
        return 'No registry published';
      case 'unresolved':
        return 'Unverified';
    }
  }

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
    'status' | 'freshness' | 'isRefreshing' | 'snapshot' | 'identityStatus'
  > | null
): 'accent' | 'muted' | 'warning' | 'danger' {
  const label = getBcmrMetadataStatusLabel(metadata);
  switch (label) {
    case 'Verified':
    case 'Fresh':
    case 'Refreshing':
      return 'accent';
    case 'Last known':
    case 'Unverified':
    case 'Offline':
      return 'warning';
    case 'Unavailable':
      return 'danger';
    case 'Cached':
    default:
      return 'muted';
  }
}
