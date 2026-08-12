import { binToHex } from '@bitauth/libauth';

import { derivePublicKeyHash } from '../../../utils/derivePublicKeyHash';
import { parseSatoshis } from '../../../utils/binary';
import type { UTXO } from '../../../types/types';

export function isWalletFundingUtxo(utxo: UTXO): boolean {
  return !utxo.contractName && !utxo.contractFunction && !utxo.abi;
}

export function sumSpendableBchBalance(utxos: UTXO[]): bigint {
  return utxos.reduce((total, utxo) => {
    if (!isWalletFundingUtxo(utxo) || utxo.token) return total;
    return total + parseSatoshis(utxo.amount ?? utxo.value ?? 0);
  }, 0n);
}

export function sumSpendableTokenBalance(
  utxos: UTXO[],
  tokenCategory: string
): bigint {
  const normalizedCategory = tokenCategory.trim().toLowerCase();
  return utxos.reduce((total, utxo) => {
    if (!isWalletFundingUtxo(utxo)) return total;
    if (
      utxo.token?.category?.trim().toLowerCase() !== normalizedCategory ||
      utxo.token?.nft ||
      utxo.token?.amount == null
    ) {
      return total;
    }
    return total + parseSatoshis(utxo.token.amount);
  }, 0n);
}

export function selectFundingUtxosByToken(
  utxos: UTXO[],
  tokenCategory: string,
  requiredTokenAmount: bigint
): {
  selected: UTXO[];
  totalAvailable: bigint;
  candidateCount: number;
} {
  const normalizedCategory = tokenCategory.trim().toLowerCase();
  const sortedTokenUtxos = [...utxos]
    .filter((utxo) => isWalletFundingUtxo(utxo))
    .filter(
      (utxo) =>
        utxo.token?.category?.trim().toLowerCase() === normalizedCategory &&
        !utxo.token?.nft &&
        parseSatoshis(utxo.token?.amount) > 0n
    )
    .sort((a, b) => {
      const bchDiff =
        parseSatoshis(b.amount ?? b.value ?? 0) -
        parseSatoshis(a.amount ?? a.value ?? 0);
      if (bchDiff !== 0n) {
        return bchDiff > 0n ? 1 : -1;
      }
      const tokenDiff =
        parseSatoshis(b.token?.amount) - parseSatoshis(a.token?.amount);
      return tokenDiff > 0n ? 1 : tokenDiff < 0n ? -1 : 0;
    });

  const seenOutpoints = new Set<string>();
  const tokenUtxos = sortedTokenUtxos.filter((utxo) => {
    const outpoint = `${utxo.tx_hash}:${utxo.tx_pos}`;
    if (seenOutpoints.has(outpoint)) return false;
    seenOutpoints.add(outpoint);
    return true;
  });

  const selected: UTXO[] = [];
  let total = 0n;
  const totalAvailable = tokenUtxos.reduce(
    (sum, utxo) => sum + parseSatoshis(utxo.token?.amount),
    0n
  );
  for (const utxo of tokenUtxos) {
    selected.push(utxo);
    total += parseSatoshis(utxo.token?.amount);
    if (total >= requiredTokenAmount) break;
  }
  return {
    selected: total >= requiredTokenAmount ? selected : [],
    totalAvailable,
    candidateCount: tokenUtxos.length,
  };
}

export function selectLargestBchUtxos(utxos: UTXO[]): UTXO[] {
  return [...utxos]
    .filter((utxo) => isWalletFundingUtxo(utxo) && !utxo.token)
    .sort((a, b) => {
      const left = parseSatoshis(b.amount ?? b.value ?? 0);
      const right = parseSatoshis(a.amount ?? a.value ?? 0);
      if (left === right) return 0;
      return left > right ? -1 : 1;
    });
}

function tryResolvePublicKeyHashHex(address: string): string | null {
  try {
    return binToHex(derivePublicKeyHash(address)).toLowerCase();
  } catch {
    return null;
  }
}

export function selectWalletBchFundingUtxo(
  utxos: UTXO[],
  ownerAddress: string
): UTXO | null {
  const normalizedOwnerAddress = ownerAddress.trim();
  if (!normalizedOwnerAddress) return null;

  const sortedBchUtxos = selectLargestBchUtxos(utxos);
  const exactMatch = sortedBchUtxos.find(
    (utxo) =>
      utxo.address === normalizedOwnerAddress ||
      utxo.tokenAddress === normalizedOwnerAddress
  );
  if (exactMatch) return exactMatch;

  const ownerPublicKeyHashHex = tryResolvePublicKeyHashHex(
    normalizedOwnerAddress
  );
  if (!ownerPublicKeyHashHex) return null;

  return (
    sortedBchUtxos.find((utxo) =>
      [utxo.address, utxo.tokenAddress].some((candidateAddress) => {
        if (!candidateAddress) return false;
        return (
          tryResolvePublicKeyHashHex(candidateAddress) === ownerPublicKeyHashHex
        );
      })
    ) ?? null
  );
}
