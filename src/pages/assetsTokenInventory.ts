import type { NftCategory } from '@bitauth/libauth';
import type { UTXO } from '../types/types';
import type { TokenCapability } from '../services/cashtokens';
import {
  lookupSequentialNftType,
  nftTickerSymbol,
  parseNftCommitment,
  type NftFieldEncoding,
  type NftParseField,
  type NftParseInfo,
  type NftParseType,
  type ParsedNftField,
} from '../services/nftParsing/nftParsing';
import { shortenHash } from '../utils/shortenHash';

function isTokenUtxo(utxo: UTXO): boolean {
  return Boolean(utxo.token?.category);
}

function isNftUtxo(utxo: UTXO): boolean {
  return Boolean(utxo.token?.nft && utxo.token?.category);
}

function capabilityRank(capability: TokenCapability): number {
  switch (capability) {
    case 'none':
      return 0;
    case 'mutable':
      return 1;
    case 'minting':
      return 2;
    default:
      return 3;
  }
}

export type NftInstanceSummary = {
  outpoint: string;
  txHash: string;
  txPos: number;
  category: string;
  capability: TokenCapability;
  commitment: string;
  utxo: UTXO;
};

export function dedupeTokenUtxos(utxos: UTXO[]): UTXO[] {
  const deduped = new Map<string, UTXO>();

  for (const utxo of utxos) {
    if (!isTokenUtxo(utxo)) continue;
    deduped.set(`${utxo.tx_hash}:${utxo.tx_pos}`, utxo);
  }

  return Array.from(deduped.values());
}

export function getStableTokenUtxos(...sources: UTXO[][]): UTXO[] {
  for (const source of sources) {
    const normalized = dedupeTokenUtxos(source);
    if (normalized.length > 0) return normalized;
  }

  return [];
}

export function summarizeNftInstances(utxos: UTXO[]): NftInstanceSummary[] {
  const seen = new Set<string>();
  const instances: NftInstanceSummary[] = [];

  for (const utxo of dedupeTokenUtxos(utxos)) {
    if (!isNftUtxo(utxo)) continue;

    const outpoint = `${utxo.tx_hash}:${utxo.tx_pos}`;
    if (seen.has(outpoint)) continue;
    seen.add(outpoint);

    const capability = utxo.token.nft!.capability;
    instances.push({
      outpoint,
      txHash: utxo.tx_hash,
      txPos: utxo.tx_pos,
      category: utxo.token.category,
      capability,
      commitment: utxo.token.nft?.commitment ?? '',
      utxo,
    });
  }

  return instances.sort((left, right) => {
    if (left.category !== right.category) {
      return left.category.localeCompare(right.category);
    }
    if (capabilityRank(left.capability) !== capabilityRank(right.capability)) {
      return capabilityRank(left.capability) - capabilityRank(right.capability);
    }
    if (left.txHash !== right.txHash) {
      return left.txHash.localeCompare(right.txHash);
    }
    if (left.txPos !== right.txPos) {
      return left.txPos - right.txPos;
    }
    return left.commitment.localeCompare(right.commitment);
  });
}

export function describeNftCapability(capability: TokenCapability): string {
  switch (capability) {
    case 'minting':
      return 'Minting NFT';
    case 'mutable':
      return 'Mutable NFT';
    default:
      return 'Plain NFT';
  }
}

export function buildNftParseInfo(
  nfts: NftCategory | undefined
): NftParseInfo | null {
  if (!nfts) return null;

  const types: Record<string, NftParseType> = {};
  for (const [key, type] of Object.entries(nfts.parse.types)) {
    types[key] = {
      name: type.name,
      description: type.description,
      fields: type.fields ? [...type.fields] : undefined,
      uris:
        type.uris && Object.keys(type.uris).length > 0 ? type.uris : undefined,
    };
  }

  const fields: Record<string, NftParseField> = {};
  if (nfts.fields) {
    for (const [id, field] of Object.entries(nfts.fields)) {
      fields[id] = {
        name: field.name,
        description: field.description,
        encoding: field.encoding as NftFieldEncoding,
      };
    }
  }

  return {
    bytecode: 'bytecode' in nfts.parse ? nfts.parse.bytecode : '',
    types,
    fields: Object.keys(fields).length > 0 ? fields : undefined,
  };
}

export type NftCardModel = {
  outpoint: string;
  txHash: string;
  txPos: number;
  category: string;
  capability: TokenCapability;
  commitment: string;
  ticker: string;
  primaryLabel: string;
  secondaryLabel: string;
  fields: ParsedNftField[];
  parsed: boolean;
  parseError?: string;
  imageUri?: string;
  utxo: UTXO;
};

export type NftCardMetadata = {
  symbol: string;
  nfts: NftCategory | undefined;
};

/**
 * Categories whose parse info is bundled with the app rather than carried by a
 * BCMR v2 registry of their own (e.g. per-loan-unique NFT categories that no
 * on-chain registry can describe). Real BCMR v2 `nfts` schemas fetched through
 * BcmrService take precedence over these.
 */
export type NftFamilyParseInfoByCategory = Record<string, NftParseInfo>;

export function buildNftCardModels(
  instances: NftInstanceSummary[],
  metadataByCategory: Record<string, NftCardMetadata | undefined>,
  familyParseInfoByCategory?: NftFamilyParseInfoByCategory
): NftCardModel[] {
  return instances.map((instance) => {
    const metadata = metadataByCategory[instance.category];
    const symbol = metadata?.symbol?.trim() || '';
    const parseInfo =
      buildNftParseInfo(metadata?.nfts) ??
      familyParseInfoByCategory?.[instance.category] ??
      null;
    const commitment = instance.commitment;

    let fields: ParsedNftField[] = [];
    let typeName: string | undefined;
    let nftTypeUris: Record<string, string> | undefined;
    let parsed = false;
    let parseError: string | undefined;

    if (parseInfo) {
      const result =
        parseInfo.bytecode.length > 0
          ? parseNftCommitment({ commitment }, parseInfo)
          : lookupSequentialNftType(commitment, parseInfo);
      if (result.success === true) {
        parsed = true;
        typeName = result.nftTypeName;
        fields = result.fields;
        nftTypeUris = result.nftTypeUris;
      } else {
        parseError = result.error;
      }
    }

    const ticker = symbol
      ? nftTickerSymbol(symbol, commitment)
      : commitment
        ? `0x${commitment}`
        : 'empty commitment';

    const card: NftCardModel = {
      ...instance,
      ticker,
      primaryLabel: parsed ? (typeName ?? ticker) : ticker,
      secondaryLabel: `${describeNftCapability(instance.capability)}${
        commitment ? ` • ${shortenHash(commitment, 8, 6)}` : ''
      }`,
      fields,
      parsed,
      parseError,
    };
    const iconUri = nftTypeUris?.icon;
    if (iconUri) {
      card.imageUri = iconUri;
    }
    return card;
  });
}
