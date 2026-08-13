import type { UTXO } from '../types/types';
import type { TokenCapability } from '../services/cashtokens';

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
