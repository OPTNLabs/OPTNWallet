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
  const tokenUtxos = [...utxos]
    .filter((utxo) => isWalletFundingUtxo(utxo))
    .filter(
      (utxo) =>
        utxo.token?.category?.trim().toLowerCase() === normalizedCategory &&
        !utxo.token?.nft &&
        parseSatoshis(utxo.token?.amount) > 0n
    )
    .filter((utxo, index, array) => {
      const outpoint = `${utxo.tx_hash}:${utxo.tx_pos}`;
      return (
        array.findIndex(
          (candidate) => `${candidate.tx_hash}:${candidate.tx_pos}` === outpoint
        ) === index
      );
    })
    .sort((a, b) =>
      Number(parseSatoshis(b.token?.amount) - parseSatoshis(a.token?.amount))
    );

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
    .sort((a, b) =>
      Number((b.amount ?? b.value ?? 0) - (a.amount ?? a.value ?? 0))
    );
}
