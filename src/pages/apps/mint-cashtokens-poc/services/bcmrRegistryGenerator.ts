// The mint screen's handle on crates/optn-core/src/bcmr_author.rs.
//
// Registries used to be assembled here in TypeScript. The bytes of a registry
// are hashed and committed on chain for good, so there must be exactly one
// implementation deciding what they are; that implementation is now the Rust
// core, shared with the CLI. This file only adapts the wallet's input shape to
// the core's request, and checks the result a second, independent way with
// libauth before anything is uploaded.
import { importMetadataRegistry, MetadataRegistry } from '@bitauth/libauth';

import {
  bcmrAuthorRegistry,
  bcmrDefaultParseBytecode,
  bcmrIpfsCid,
  bcmrParsableCommitment,
  bcmrReadPublication,
  bcmrSequentialCommitment,
  bcmrSuggestIdentity,
  bcmrSymbolError,
  ensureOptnCore,
} from '../../../../wasm/optn-core';

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
  /** Documentation only; published under the field's `extensions`. */
  offset?: string;
  /** Documentation only; published under the field's `extensions`. */
  byteLength?: string;
  uris?: Record<string, string>;
  extensions?: Record<string, unknown>;
};

export type BcmrNftTypeInput = {
  name: string;
  description?: string;
  fields?: string[];
  uris?: Record<string, string>;
};

/**
 * How the category's NFT commitments are read. A parsable collection with no
 * `bytecode`, `fields` or `types` gets the default type-and-serial layout.
 */
export type BcmrNftsSchemaInput =
  | {
      kind: 'parsable';
      description?: string;
      bytecode?: string;
      fields?: Record<string, BcmrNftFieldInput>;
      types?: Record<string, BcmrNftTypeInput>;
    }
  | {
      kind: 'sequential';
      description?: string;
      types?: Record<string, BcmrNftTypeInput>;
    };

export type BcmrNetwork = 'mainnet' | 'chipnet' | 'regtest';

export type BcmrGeneratorInput = {
  network: BcmrNetwork;
  authbase: string;
  tokenCategory: string;
  tokenName: string;
  tokenDescription?: string;
  tokenSymbol: string;
  tokenDecimals: number;
  iconUri?: string;
  webUri?: string;
  /** Defaults to now. */
  latestRevision?: string;
  baseRegistry?: MetadataRegistry | string;
  /** Present exactly when the category will hold NFTs. */
  nfts?: BcmrNftsSchemaInput;
};

/** The registry to publish, and where IPFS will serve it. */
export type AuthoredBcmrRegistry = {
  /** The exact bytes to upload and hash. Never re-serialize them. */
  registryJson: string;
  sha256: string;
  ipfsCid: string;
  ipfsUri: string;
};

export type BcmrErrorField =
  | 'tokenCategory'
  | 'tokenName'
  | 'tokenSymbol'
  | 'tokenDecimals'
  | 'iconUri'
  | 'webUri'
  | 'nftBytecode'
  | 'nftTypes'
  | 'nftFields'
  | 'registry'
  | 'general';

/** A rejected registry input, naming the form field it is about. */
export class BcmrRegistryError extends Error {
  readonly field: BcmrErrorField;

  constructor(field: BcmrErrorField, message: string) {
    super(message);
    this.name = 'BcmrRegistryError';
    this.field = field;
  }
}

const MAX_U32 = 0xffff_ffff;

function toRegistryError(error: unknown): BcmrRegistryError {
  const raw =
    typeof error === 'string'
      ? error
      : error instanceof Error
        ? error.message
        : String(error);
  try {
    const parsed = JSON.parse(raw) as { field?: string; message?: string };
    if (parsed && typeof parsed.message === 'string') {
      return new BcmrRegistryError(
        (parsed.field as BcmrErrorField) ?? 'general',
        parsed.message
      );
    }
  } catch {
    // Not the core's structured error; fall through.
  }
  return new BcmrRegistryError('general', raw);
}

function fieldForCore(
  id: string,
  field: BcmrNftFieldInput
): Record<string, unknown> {
  const out: Record<string, unknown> = { encoding: field.encoding };
  if (field.name?.trim()) out.name = field.name.trim();
  if (field.description?.trim()) out.description = field.description.trim();
  if (field.uris && Object.keys(field.uris).length > 0) out.uris = field.uris;
  const extensions: Record<string, unknown> = { ...(field.extensions ?? {}) };
  if (field.offset !== undefined) {
    const offset = field.offset.trim();
    if (!/^\d+$/.test(offset)) {
      throw new BcmrRegistryError(
        'nftFields',
        `NFT field "${id}" offset must be a non-negative integer.`
      );
    }
    extensions.offset = offset;
  }
  if (field.byteLength !== undefined) {
    const length = field.byteLength.trim();
    if (!/^\d+$/.test(length) && length !== 'variable') {
      throw new BcmrRegistryError(
        'nftFields',
        `NFT field "${id}" byteLength must be an integer or "variable".`
      );
    }
    extensions.byteLength = length;
  }
  if (Object.keys(extensions).length > 0) out.extensions = extensions;
  return out;
}

function nftsForCore(nfts: BcmrNftsSchemaInput): Record<string, unknown> {
  if (nfts.kind === 'sequential') {
    return {
      kind: 'sequential',
      description: nfts.description ?? '',
      types: nfts.types ?? {},
    };
  }
  const out: Record<string, unknown> = {
    kind: 'parsable',
    description: nfts.description ?? '',
  };
  if (nfts.bytecode !== undefined) out.bytecode = nfts.bytecode;
  if (nfts.fields !== undefined) {
    out.fields = Object.fromEntries(
      Object.entries(nfts.fields).map(([id, field]) => [
        id,
        fieldForCore(id, field),
      ])
    );
  }
  if (nfts.types !== undefined) out.types = nfts.types;
  return out;
}

/** Build the registry to publish. Throws {@link BcmrRegistryError}. */
export function generateBcmrRegistry(
  input: BcmrGeneratorInput
): AuthoredBcmrRegistry {
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
      nfts: input.nfts ? nftsForCore(input.nfts) : null,
    },
  };
  if (
    !Number.isInteger(request.identity.decimals) ||
    request.identity.decimals < 0
  ) {
    throw new BcmrRegistryError(
      'tokenDecimals',
      'Token decimals must be between 0 and 18.'
    );
  }

  let authored: AuthoredBcmrRegistry;
  try {
    authored = JSON.parse(
      bcmrAuthorRegistry(JSON.stringify(request))
    ) as AuthoredBcmrRegistry;
  } catch (error) {
    throw toRegistryError(error);
  }

  // A second, independent reader. If libauth cannot import what the core
  // wrote, nothing is published.
  const imported = importMetadataRegistry(authored.registryJson);
  if (typeof imported === 'string') {
    throw new BcmrRegistryError('registry', imported);
  }
  return authored;
}

export function generateBcmrRegistryJson(input: BcmrGeneratorInput): string {
  return generateBcmrRegistry(input).registryJson;
}

/** A default name and symbol derived from the token's category. */
export function suggestBcmrIdentity(
  category: string,
  hasNfts: boolean
): { name: string; symbol: string } {
  ensureOptnCore();
  try {
    return JSON.parse(bcmrSuggestIdentity(category, hasNfts)) as {
      name: string;
      symbol: string;
    };
  } catch (error) {
    throw toRegistryError(error);
  }
}

/** Why `symbol` is not a valid ticker, or `undefined` when it is. */
export function bcmrSymbolProblem(symbol: string): string | undefined {
  ensureOptnCore();
  return bcmrSymbolError(symbol.trim()) ?? undefined;
}

function requireU32(value: number, what: string): number {
  // wasm-bindgen converts a JS number to u32 with ToUint32, which wraps
  // negatives and truncates fractions without complaint.
  if (!Number.isInteger(value) || value < 0 || value > MAX_U32) {
    throw new BcmrRegistryError(
      'nftTypes',
      `${what} must be a whole number between 0 and ${MAX_U32}.`
    );
  }
  return value;
}

/** Commitment hex of NFT number `number` in a sequential collection. */
export function sequentialNftCommitment(number: number): string {
  ensureOptnCore();
  return bcmrSequentialCommitment(requireU32(number, 'NFT number'));
}

/** Commitment hex of serial `serial` in the default parsable layout. */
export function parsableNftCommitment(serial: number, typeByte = 0): string {
  ensureOptnCore();
  if (!Number.isInteger(typeByte) || typeByte < 0 || typeByte > 0xff) {
    throw new BcmrRegistryError(
      'nftTypes',
      'NFT type must be a single byte (0-255).'
    );
  }
  return bcmrParsableCommitment(typeByte, requireU32(serial, 'Serial number'));
}

/** Parse bytecode of the default type-and-serial layout. */
export function defaultParseBytecode(): string {
  ensureOptnCore();
  return bcmrDefaultParseBytecode();
}

/** The IPFS CID (CIDv1, raw) IPFS assigns this content with cid-version=1. */
export function ipfsCidOf(content: string | Uint8Array): string {
  ensureOptnCore();
  const bytes =
    typeof content === 'string' ? new TextEncoder().encode(content) : content;
  return bcmrIpfsCid(bytes);
}

/** What a BCMR publication output commits to. */
export type BcmrPublicationRead = { sha256: string; uris: string[] };

/**
 * Read a publication output back with the core's reader, or `undefined` when
 * `lockingBytecode` is not one.
 */
export function readBcmrPublication(
  lockingBytecode: Uint8Array
): BcmrPublicationRead | undefined {
  ensureOptnCore();
  const read = bcmrReadPublication(lockingBytecode);
  return read ? (JSON.parse(read) as BcmrPublicationRead) : undefined;
}
