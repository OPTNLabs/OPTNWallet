import type { UTXO } from '../../../../types/types';

export type MintSourceKind =
  | 'genesis'
  | 'plain-nft'
  | 'mutable-nft'
  | 'minting-nft'
  | 'fungible-token';

export function getMintSourceCategory(utxo: UTXO): string {
  return utxo.token?.category ?? utxo.tx_hash;
}

export function getMintSourceKind(utxo: UTXO): MintSourceKind {
  if (!utxo.token?.nft) {
    return utxo.tx_pos === 0 && !utxo.token ? 'genesis' : 'fungible-token';
  }

  switch (utxo.token.nft.capability) {
    case 'mutable':
      return 'mutable-nft';
    case 'minting':
      return 'minting-nft';
    default:
      return 'plain-nft';
  }
}

export function isGenesisMintSource(utxo: UTXO): boolean {
  return getMintSourceKind(utxo) === 'genesis';
}

export function isMintingAuthorityMintSource(utxo: UTXO): boolean {
  return getMintSourceKind(utxo) === 'minting-nft';
}

export function canMintFungibleFromSource(utxo: UTXO): boolean {
  return isGenesisMintSource(utxo);
}

export function isSelectableMintSource(utxo: UTXO): boolean {
  return isGenesisMintSource(utxo) || isMintingAuthorityMintSource(utxo);
}

function toBigIntValue(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return BigInt(Math.trunc(value));
  }
  if (typeof value === 'string') {
    try {
      return BigInt(value.trim() || '0');
    } catch {
      return 0n;
    }
  }
  return 0n;
}

export function selectMintSourceUtxos(allUtxos: UTXO[]): UTXO[] {
  if (!Array.isArray(allUtxos)) return [];

  return allUtxos
    .filter(isSelectableMintSource)
    .sort((left, right) => {
      const leftKind = getMintSourceKind(left);
      const rightKind = getMintSourceKind(right);
      const kindRank: Record<MintSourceKind, number> = {
        genesis: 0,
        'minting-nft': 1,
        'mutable-nft': 2,
        'plain-nft': 3,
        'fungible-token': 4,
      };

      if (kindRank[leftKind] !== kindRank[rightKind]) {
        return kindRank[leftKind] - kindRank[rightKind];
      }

      const leftValue = toBigIntValue(left.value ?? left.amount);
      const rightValue = toBigIntValue(right.value ?? right.amount);
      if (leftValue !== rightValue) {
        return rightValue > leftValue ? 1 : -1;
      }

      if (left.tx_hash !== right.tx_hash) {
        return left.tx_hash.localeCompare(right.tx_hash);
      }

      return left.tx_pos - right.tx_pos;
    });
}
