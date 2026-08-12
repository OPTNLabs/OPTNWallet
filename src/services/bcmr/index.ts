import { importMetadataRegistry, type IdentityHistory, type IdentitySnapshot, type MetadataRegistry, type RegistryTimestampKeyedValues } from '@bitauth/libauth';

type RegistryWithIdentity = MetadataRegistry & {
  registryIdentity?: string | Record<string, unknown>;
};

type ChaingraphOutput = {
  locking_bytecode?: string;
  scriptPubKey?: { hex?: string };
};

export type BcmrIndexerTokenResponse = {
  name?: string;
  description?: string;
  uris?: Record<string, string>;
  token?: {
    category?: string;
    symbol?: string;
    decimals?: number;
  };
  extensions?: Record<string, unknown>;
};

type TokenIndexBcmrSnapshot = {
  name?: string;
  description?: string;
  token?: {
    category?: string;
    symbol?: string;
    decimals?: number;
  } & Record<string, unknown>;
  uris?: Record<string, string>;
};

export type TokenIndexBcmrResponse = {
  category?: string;
  name?: string;
  description?: string;
  symbol?: string;
  decimals?: number;
  latest_revision?: string;
  updated_at?: string;
  updated_height?: number;
  uris?: Record<string, string | null>;
  identity_snapshot?: TokenIndexBcmrSnapshot;
  nft_types?: Record<string, unknown> | null;
  bcmr?: {
    category?: string;
    name?: string;
    description?: string;
    symbol?: string;
    decimals?: number;
    latest_revision?: string;
    uris?: Record<string, string | null>;
    identity_snapshot?: TokenIndexBcmrSnapshot;
    nft_types?: Record<string, unknown> | null;
    registry?: {
      validity_checks?: Record<string, unknown>;
      source_url?: string;
    };
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function dedupeUrls(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const url of urls) {
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

function getSvgMimeType(bytes: Uint8Array): string | null {
  try {
    const text = new TextDecoder().decode(bytes.slice(0, 512)).trimStart();
    if (text.startsWith('<svg') || text.includes('<svg')) return 'image/svg+xml';
    if (text.startsWith('<?xml') && text.includes('<svg')) return 'image/svg+xml';
  } catch {
    return null;
  }
  return null;
}

export function detectImageMimeType(bytes: Uint8Array, contentType?: string | null): string {
  const normalizedContentType = String(contentType ?? '').split(';', 1)[0].trim().toLowerCase();
  if (normalizedContentType.startsWith('image/')) return normalizedContentType;
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return 'image/gif';
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp';
  if (bytes.length >= 4 && bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01 && bytes[3] === 0x00) return 'image/x-icon';
  if (bytes.length >= 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    const brand = new TextDecoder().decode(bytes.slice(8, 12)).toLowerCase();
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
  }
  return getSvgMimeType(bytes) ?? (normalizedContentType || 'image/*');
}

export function encodeIconCachePayload(base64: string, contentType: string): string {
  return JSON.stringify({ base64, contentType });
}

export function decodeIconCachePayload(payload: string): { dataUri: string } {
  try {
    const parsed = JSON.parse(payload) as { base64?: string; contentType?: string };
    if (typeof parsed.base64 === 'string' && parsed.base64 && typeof parsed.contentType === 'string' && parsed.contentType) {
      return { dataUri: `data:${parsed.contentType};base64,${parsed.base64}` };
    }
  } catch {
    return { dataUri: `data:image/*;base64,${payload}` };
  }
  return { dataUri: `data:image/*;base64,${payload}` };
}

export function normalizeHexId(value: string): string {
  return String(value ?? '').trim().toLowerCase().replace(/^0x/i, '');
}

export function isTokenIndexNativeRegistryUri(uri: string): boolean {
  return /\/v1\/token\/[0-9a-f]{64}\/bcmr\/?$/i.test(String(uri ?? '').trim());
}

export function buildTokenLookupUrl(registryUrl: string, category: string): string | null {
  const match = registryUrl.match(/^(.*)\/registries\/[^/]+\/latest\/?$/i);
  if (!match) return null;
  return `${match[1]}/tokens/${normalizeHexId(category)}/`;
}

export function isSyntheticTokenLookupRegistryUri(uri: string): boolean {
  return /\/tokens\/[0-9a-f]{64}\/?$/i.test(String(uri ?? '').trim());
}

export function getChaingraphOutputHex(output: ChaingraphOutput): string {
  return String(output.locking_bytecode ?? output.scriptPubKey?.hex ?? '').replace(/^\\x/i, '').replace(/^0x/i, '').trim().toLowerCase();
}

export function hasIdentityHistory(
  registry: MetadataRegistry
): registry is MetadataRegistry & {
  identities: Record<string, RegistryTimestampKeyedValues<IdentitySnapshot>>;
} {
  return typeof registry === 'object' && registry !== null && !!registry.identities;
}

export function getRegistryIdentity(registry: MetadataRegistry): string | undefined {
  const maybe = registry as RegistryWithIdentity;
  if (typeof maybe.registryIdentity !== 'string') return undefined;
  const out = maybe.registryIdentity.toLowerCase();
  return /^[0-9a-f]{64}$/.test(out) ? out : undefined;
}

export function getNftUrisForCommitment(
  snapshot: IdentitySnapshot,
  nftCommitment: string
): Record<string, string> | undefined {
  const nfts = snapshot.token?.nfts as
    | { types?: Record<string, { uris?: Record<string, string> }> }
    | undefined;
  return nfts?.types?.[nftCommitment]?.uris;
}

export function findLatestSnapshotInHistory(
  history: IdentityHistory | undefined
): IdentitySnapshot | null {
  if (!history) return null;
  const revisions = Object.keys(history).sort().reverse();
  if (revisions.length === 0) return null;
  return history[revisions[0]] ?? null;
}

export function findSnapshotForCategory(
  category: string,
  registry: MetadataRegistry
): IdentitySnapshot | null {
  const normalizedCategory = normalizeHexId(category);
  if (!normalizedCategory || !hasIdentityHistory(registry)) return null;

  let best: { revision: string; snapshot: IdentitySnapshot } | null = null;
  for (const history of Object.values(registry.identities)) {
    for (const [revision, snapshot] of Object.entries(history)) {
      if (normalizeHexId(snapshot.token?.category || '') !== normalizedCategory) {
        continue;
      }
      if (!best || revision > best.revision) {
        best = { revision, snapshot };
      }
    }
  }

  return best?.snapshot ?? null;
}

export function normalizeTokenIndexSnapshot(
  authbase: string,
  payload: TokenIndexBcmrResponse
): MetadataRegistry | null {
  const rootSnapshot = payload.identity_snapshot ?? payload.bcmr?.identity_snapshot;
  if (!rootSnapshot || !isRecord(rootSnapshot)) return null;

  const rootToken = isRecord(rootSnapshot.token) ? rootSnapshot.token : {};
  const payloadToken =
    isRecord(payload.bcmr?.identity_snapshot?.token)
      ? payload.bcmr?.identity_snapshot?.token
      : {};

  const payloadNfts = payload.nft_types ?? payload.bcmr?.nft_types;
  const nftTypes =
    isRecord(payloadNfts) && Object.keys(payloadNfts).length > 0
      ? {
          types: payloadNfts,
        }
      : undefined;

  const category = normalizeHexId(
    String(rootToken.category ?? payload.category ?? payload.bcmr?.category ?? authbase)
  );
  if (!category) return null;

  const decimalsRaw = payload.decimals ?? rootToken.decimals ?? payloadToken.decimals;
  const decimals = Number.isFinite(Number(decimalsRaw))
    ? Math.max(0, Math.trunc(Number(decimalsRaw)))
    : 0;

  const symbol = String(payload.symbol ?? rootToken.symbol ?? payloadToken.symbol ?? '').trim();
  const name = String(payload.name ?? rootSnapshot.name ?? '').trim() || category;
  const description = String(payload.description ?? rootSnapshot.description ?? '').trim();
  const latestRevision = String(
    payload.latest_revision ?? payload.bcmr?.latest_revision ?? payload.updated_at ?? new Date().toISOString()
  ).trim();

  const snapshot: IdentitySnapshot = {
    name,
    description: description || undefined,
    token: (() => {
      const token = {
        category,
        symbol,
        decimals,
      } as IdentitySnapshot['token'];
      if (nftTypes) {
        (token as unknown as Record<string, unknown>).nfts = nftTypes;
      }
      return token;
    })(),
    uris: isRecord(rootSnapshot.uris)
      ? (rootSnapshot.uris as Record<string, string>)
      : isRecord(payload.uris)
        ? (payload.uris as Record<string, string>)
        : undefined,
  };

  const registry = {
    $schema: 'https://cashtokens.org/bcmr-v2.schema.json',
    version: { major: 0, minor: 0, patch: 0 },
    latestRevision,
    registryIdentity: normalizeHexId(authbase),
    identities: {
      [normalizeHexId(authbase)]: {
        [latestRevision]: snapshot,
      },
    },
  };

  const imported = importMetadataRegistry(registry);
  if (typeof imported === 'string') return null;
  return imported;
}
