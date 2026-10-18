// Adapt the retained mint form to optn-core. Validation, schema inheritance and
// authoring stay in Rust; the returned bytes are uploaded without reserialization.
import {
  importMetadataRegistry,
  type MetadataRegistry,
  type IdentityHistory,
} from '@bitauth/libauth';
import { bcmrAuthorRegistry, ensureOptnCore } from '../../../../wasm/optn-core';

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
  network: 'mainnet' | 'chipnet' | 'regtest';
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

export function generateBcmrRegistry(
  input: BcmrGeneratorInput
): BcmrV2Registry {
  return JSON.parse(generateBcmrRegistryJson(input)) as BcmrV2Registry;
}

export function generateBcmrRegistryJson(input: BcmrGeneratorInput): string {
  ensureOptnCore();
  const request = {
    network: input.network,
    revision: input.latestRevision?.trim() || new Date().toISOString(),
    baseRegistry:
      input.baseRegistry === undefined
        ? null
        : typeof input.baseRegistry === 'string'
          ? input.baseRegistry
          : JSON.stringify(input.baseRegistry),
    identity: {
      authbase: input.authbase,
      category: input.tokenCategory,
      name: input.tokenName,
      description: input.tokenDescription ?? '',
      symbol: input.tokenSymbol,
      decimals: input.tokenDecimals,
      iconUri: input.iconUri ?? '',
      webUri: input.webUri ?? '',
      nfts: input.nfts ? { ...input.nfts, kind: 'schema' } : null,
    },
  };

  let authored: { registryJson: string };
  try {
    authored = JSON.parse(bcmrAuthorRegistry(JSON.stringify(request))) as {
      registryJson: string;
    };
  } catch (error) {
    // wasm-bindgen throws the core's structured error as a string.
    const raw = error instanceof Error ? error.message : String(error);
    let message = raw;
    try {
      const parsed = JSON.parse(raw) as { message?: string };
      if (typeof parsed.message === 'string') message = parsed.message;
    } catch {
      // Preserve non-JSON initialization/transport errors.
    }
    throw new Error(message);
  }

  // Preserve the existing independent reader before upload/publication.
  const imported = importMetadataRegistry(authored.registryJson);
  if (typeof imported === 'string') throw new Error(imported);
  return authored.registryJson;
}
