import { UTXO } from '../../types/types';

export type HomeTokenTotals = Record<
  string,
  { amount: bigint; decimals: number }
>;

export function calculateBalance(utxos: Record<string, UTXO[]>) {
  return Object.values(utxos)
    .flat()
    .reduce((total, utxo) => total + (utxo.value || 0), 0);
}

function toBigIntAmount(amount: unknown): bigint {
  if (typeof amount === 'bigint') return amount;
  if (typeof amount === 'number' && Number.isFinite(amount)) {
    return BigInt(Math.trunc(amount));
  }
  if (typeof amount === 'string') {
    try {
      return BigInt(amount);
    } catch {
      const parsed = Number(amount);
      return Number.isFinite(parsed) ? BigInt(Math.trunc(parsed)) : 0n;
    }
  }
  return 0n;
}

export function calculateCashTokenTotals(utxos: Record<string, UTXO[]>) {
  const tokenTotals: HomeTokenTotals = {};

  Object.values(utxos)
    .flat()
    .forEach((utxo) => {
      const { category, amount, BcmrTokenMetadata } = utxo.token || {};
      if (!category) return;

      const parsedAmount = toBigIntAmount(amount);
      const decimals = BcmrTokenMetadata?.token?.decimals ?? 0;
      if (tokenTotals[category]) {
        tokenTotals[category].amount += parsedAmount;
      } else {
        tokenTotals[category] = { amount: parsedAmount, decimals };
      }
    });

  return tokenTotals;
}
