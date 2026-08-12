import {
  importMetadataRegistry,
  MetadataRegistry,
  IdentityHistory,
} from '@bitauth/libauth';

export type BcmrGeneratorInput = {
  authbase: string;
  tokenCategory: string;
  tokenName: string;
  tokenDescription?: string;
  tokenSymbol: string;
  tokenDecimals: number;
  iconUri?: string;
  webUri?: string;
  latestRevision?: string;
  registryName?: string;
  registryDescription?: string;
  baseRegistry?: MetadataRegistry | string;
};

type BcmrV2Registry = {
  $schema: string;
  version: { major: number; minor: number; patch: number };
  latestRevision: string;
  registryIdentity: string;
  identities: Record<string, IdentityHistory>;
};

function requireText(value: string, field: string): string {
  const out = value.trim();
  if (!out) throw new Error(`${field} is required.`);
  return out;
}

function requireHexTxid(value: string, field: string): string {
  const out = requireText(value, field).toLowerCase();
  if (!/^[0-9a-f]{64}$/i.test(out)) {
    throw new Error(`${field} must be 64 hex characters.`);
  }
  return out;
}

function requireIsoTimestamp(value: string): string {
  const out = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(out)) {
    throw new Error(
      'Latest revision must be an ISO timestamp like 2026-01-01T00:00:00.000Z.'
    );
  }
  return out;
}

function ensureValidRegistry(registry: BcmrV2Registry): BcmrV2Registry {
  const imported = importMetadataRegistry(registry);
  if (typeof imported === 'string') {
    throw new Error(imported);
  }
  return registry;
}

function normalizeBaseRegistry(
  registry: MetadataRegistry | string | undefined
): BcmrV2Registry | undefined {
  if (!registry) return undefined;
  const imported =
    typeof registry === 'string' ? importMetadataRegistry(registry) : registry;
  if (typeof imported === 'string') {
    throw new Error(imported);
  }
  return imported as BcmrV2Registry;
}

export function generateBcmrRegistry(input: BcmrGeneratorInput): BcmrV2Registry {
  const authbase = requireHexTxid(input.authbase, 'Authbase');
  const tokenCategory = requireHexTxid(input.tokenCategory, 'Token category');
  const tokenName = requireText(input.tokenName, 'Token name');
  const tokenSymbol = requireText(input.tokenSymbol, 'Token symbol');
  const latestRevision = input.latestRevision?.trim()
    ? requireIsoTimestamp(input.latestRevision)
    : new Date().toISOString();

  const uris: Record<string, string> = {};
  if (input.iconUri?.trim()) {
    uris.icon = input.iconUri.trim();
  }
  if (input.webUri?.trim()) {
    uris.web = input.webUri.trim();
  }

  const snapshot: BcmrV2Registry['identities'][string][string] = {
    name: tokenName,
    description: input.tokenDescription?.trim() || undefined,
    token: {
      category: tokenCategory,
      symbol: tokenSymbol,
      decimals: Number.isFinite(input.tokenDecimals)
        ? Math.max(0, Math.trunc(input.tokenDecimals))
        : 0,
    },
    uris: Object.keys(uris).length > 0 ? uris : undefined,
  };

  const baseRegistry = normalizeBaseRegistry(input.baseRegistry);
  const mergedIdentities: Record<string, IdentityHistory> = {
    ...(baseRegistry?.identities || {}),
  };
  mergedIdentities[authbase] = {
    ...(mergedIdentities[authbase] || {}),
    [latestRevision]: snapshot,
  };

  return ensureValidRegistry({
    $schema: 'https://cashtokens.org/bcmr-v2.schema.json',
    version: {
      major: baseRegistry?.version?.major ?? 0,
      minor: baseRegistry?.version?.minor ?? 0,
      patch: (baseRegistry?.version?.patch ?? 0) + 1,
    },
    latestRevision,
    registryIdentity: authbase,
    identities: mergedIdentities,
  });
}

export function generateBcmrRegistryJson(input: BcmrGeneratorInput): string {
  return JSON.stringify(generateBcmrRegistry(input));
}
