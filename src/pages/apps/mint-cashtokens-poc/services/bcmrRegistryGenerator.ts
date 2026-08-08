import {
  importMetadataRegistry,
  MetadataRegistry,
  IdentityHistory,
} from '@bitauth/libauth';

export type BcmrNftFieldEncoding =
  | {
      type:
        | 'binary'
        | 'boolean'
        | 'hex'
        | 'https-url'
        | 'ipfs-cid'
        | 'utf8'
        | 'locktime';
    }
  | {
      type: 'number';
      aggregate?: 'add';
      decimals?: number;
      unit?: string;
    };

export type BcmrNftFieldInput = {
  name?: string;
  description?: string;
  encoding: BcmrNftFieldEncoding;
  offset?: string;
  byteLength?: string;
  uris?: Record<string, string>;
};

export type BcmrNftTypeInput = {
  name: string;
  description?: string;
  fields?: string[];
  uris?: Record<string, string>;
};

export type BcmrNftsSchemaInput = {
  description?: string;
  fields?: Record<string, BcmrNftFieldInput>;
  parse: {
    bytecode?: string;
    types?: Record<string, BcmrNftTypeInput>;
  };
};

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
  nfts?: BcmrNftsSchemaInput;
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

type BcmrNftsLike = {
  description?: string;
  fields?: Record<string, Record<string, unknown>>;
  parse?: {
    bytecode?: string;
    types?: Record<string, Record<string, unknown>>;
  };
};

const NFT_FIELD_ENCODING_TYPES = new Set([
  'binary',
  'boolean',
  'hex',
  'https-url',
  'ipfs-cid',
  'locktime',
  'number',
  'utf8',
]);

function requireEvenHex(value: string, field: string): string {
  const out = value.trim().toLowerCase();
  if (!/^[0-9a-f]*$/.test(out) || out.length % 2 !== 0) {
    throw new Error(`${field} must be even-length hex.`);
  }
  return out;
}

function normalizeNftField(
  id: string,
  field: BcmrNftFieldInput
): Record<string, unknown> {
  const fieldId = requireText(id, 'NFT field identifier');
  if (!NFT_FIELD_ENCODING_TYPES.has(field.encoding.type)) {
    throw new Error(
      `NFT field "${fieldId}" has an unsupported encoding type "${field.encoding.type}".`
    );
  }
  const encoding: Record<string, unknown> = { type: field.encoding.type };
  if (field.encoding.type === 'number') {
    const decimals = field.encoding.decimals;
    if (decimals !== undefined) {
      if (
        !Number.isInteger(decimals) ||
        decimals < 0 ||
        decimals > 18
      ) {
        throw new Error(
          `NFT field "${fieldId}" decimals must be an integer between 0 and 18.`
        );
      }
      encoding.decimals = decimals;
    }
    if (field.encoding.aggregate !== undefined) {
      if (field.encoding.aggregate !== 'add') {
        throw new Error(
          `NFT field "${fieldId}" aggregate must be "add".`
        );
      }
      encoding.aggregate = field.encoding.aggregate;
    }
    if (field.encoding.unit?.trim()) {
      encoding.unit = field.encoding.unit.trim();
    }
  }
  const out: Record<string, unknown> = { encoding };
  if (field.name?.trim()) {
    out.name = field.name.trim();
  }
  if (field.description?.trim()) {
    out.description = field.description.trim();
  }
  const extensions: Record<string, string> = {};
  if (field.offset !== undefined) {
    if (!/^\d+$/.test(field.offset.trim())) {
      throw new Error(
        `NFT field "${fieldId}" offset must be a non-negative integer.`
      );
    }
    extensions.offset = field.offset.trim();
  }
  if (field.byteLength !== undefined) {
    const length = field.byteLength.trim();
    if (!/^\d+$/.test(length) && length !== 'variable') {
      throw new Error(
        `NFT field "${fieldId}" byteLength must be an integer or "variable".`
      );
    }
    extensions.byteLength = length;
  }
  if (Object.keys(extensions).length > 0) {
    out.extensions = extensions;
  }
  if (field.uris && Object.keys(field.uris).length > 0) {
    out.uris = field.uris;
  }
  return out;
}

function normalizeNftType(
  key: string,
  type: BcmrNftTypeInput
): Record<string, unknown> {
  const typeKey = requireEvenHex(key, 'NFT type key');
  const out: Record<string, unknown> = {
    name: requireText(type.name, `NFT type "${typeKey}" name`),
  };
  if (type.description?.trim()) {
    out.description = type.description.trim();
  }
  if (type.fields && type.fields.length > 0) {
    out.fields = type.fields.map((id) => requireText(id, 'NFT field identifier'));
  }
  if (type.uris && Object.keys(type.uris).length > 0) {
    out.uris = type.uris;
  }
  return out;
}

type NormalizedNftsSchema = {
  description?: string;
  fields?: Record<string, Record<string, unknown>>;
  parse: {
    bytecode?: string;
    types?: Record<string, Record<string, unknown>>;
  };
};

function normalizeNftsSchema(input: BcmrNftsSchemaInput): NormalizedNftsSchema {
  const fields: Record<string, Record<string, unknown>> = {};
  for (const [id, field] of Object.entries(input.fields ?? {})) {
    fields[id] = normalizeNftField(id, field);
  }
  const types: Record<string, Record<string, unknown>> = {};
  for (const [key, type] of Object.entries(input.parse.types ?? {})) {
    types[key] = normalizeNftType(key, type);
  }
  const bytecode = input.parse.bytecode?.trim()
    ? requireEvenHex(input.parse.bytecode, 'Parse bytecode')
    : undefined;
  return {
    description: input.description?.trim() || undefined,
    fields: Object.keys(fields).length > 0 ? fields : undefined,
    parse: {
      bytecode,
      types: Object.keys(types).length > 0 ? types : undefined,
    },
  };
}

function latestIdentitySnapshot(
  identity: IdentityHistory | undefined,
  revision: string
): Record<string, unknown> | undefined {
  if (!identity) return undefined;
  const timestamps = Object.keys(identity)
    .filter((timestamp) => timestamp <= revision)
    .sort();
  const latest = timestamps[timestamps.length - 1];
  return latest ? identity[latest] : undefined;
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

  const baseRegistry = normalizeBaseRegistry(input.baseRegistry);

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

  if (input.nfts) {
    const baseIdentity = baseRegistry?.identities?.[authbase];
    const baseNfts = (
      latestIdentitySnapshot(baseIdentity, latestRevision)?.token as
        | { nfts?: BcmrNftsLike }
        | undefined
    )?.nfts;
    const normalized = normalizeNftsSchema(input.nfts);

    const mergedFields = {
      ...(baseNfts?.fields ?? {}),
      ...(normalized.fields ?? {}),
    };
    const mergedTypes = {
      ...(baseNfts?.parse?.types ?? {}),
      ...(normalized.parse.types ?? {}),
    };

    const token = snapshot.token as {
      nfts?: {
        description?: string;
        fields?: Record<string, Record<string, unknown>>;
        parse: {
          bytecode?: string;
          types: Record<string, Record<string, unknown>>;
        };
      };
    };
    token.nfts = {
      description: normalized.description || baseNfts?.description || undefined,
      fields: Object.keys(mergedFields).length > 0 ? mergedFields : undefined,
      parse: {
        bytecode: normalized.parse.bytecode ?? baseNfts?.parse?.bytecode ?? undefined,
        types: mergedTypes,
      },
    };
  }

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
