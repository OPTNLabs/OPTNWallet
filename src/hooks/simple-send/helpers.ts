import { UTXO } from '../../types/types';

export function validateRecipient(addr: string) {
  return typeof addr === 'string' && addr.trim().length > 10;
}

export function normalizeDecimalInput(value: string, decimals: number): string {
  const maxDecimals = Math.max(0, Math.trunc(decimals));
  const raw = String(value ?? '').trim();
  if (!raw) return '';

  const cleaned = raw.replace(/[^0-9.]/g, '');
  if (!cleaned) return '';

  const firstDot = cleaned.indexOf('.');
  const wholeRaw = firstDot >= 0 ? cleaned.slice(0, firstDot) : cleaned;
  const fractionRaw =
    firstDot >= 0 ? cleaned.slice(firstDot + 1).replace(/\./g, '') : '';

  const whole = wholeRaw.replace(/^0+(?=\d)/, '') || '0';
  if (maxDecimals <= 0) {
    return whole;
  }

  const fraction = fractionRaw.slice(0, maxDecimals);
  if (firstDot >= 0) {
    return fraction.length > 0 ? `${whole}.${fraction}` : `${whole}.`;
  }

  return whole;
}

export function parseDecimalAmountToAtomic(
  value: string,
  decimals: number
): bigint {
  const normalized = normalizeDecimalInput(value, decimals);
  if (!normalized) return 0n;

  const maxDecimals = Math.max(0, Math.trunc(decimals));
  const [wholeRaw, fractionRaw = ''] = normalized.split('.');
  const whole = wholeRaw.trim() || '0';
  if (!/^\d+$/.test(whole)) return 0n;

  const scale = 10n ** BigInt(maxDecimals);
  if (maxDecimals <= 0) {
    return BigInt(whole);
  }

  const fraction = fractionRaw.replace(/[^0-9]/g, '').slice(0, maxDecimals);
  const paddedFraction = fraction.padEnd(maxDecimals, '0');

  return BigInt(whole) * scale + BigInt(paddedFraction || '0');
}

export function parseAmountToSats(val: string): number {
  const sats = parseDecimalAmountToAtomic(val, 8);
  if (sats <= 0n) return 0;
  return Number(sats);
}

export function resolveTokenDecimalsByCategory(
  tokenUtxos: UTXO[]
): Record<string, number> {
  const decimalsByCategory: Record<string, number> = {};

  for (const utxo of tokenUtxos) {
    const category = utxo.token?.category;
    if (!category) continue;

    const metadataDecimals = utxo.token?.BcmrTokenMetadata?.token?.decimals;
    const tokenDecimals =
      typeof metadataDecimals === 'number' && Number.isFinite(metadataDecimals)
        ? Math.max(0, Math.trunc(metadataDecimals))
        : undefined;

    if (tokenDecimals === undefined) continue;

    const current = decimalsByCategory[category];
    if (current == null || (current === 0 && tokenDecimals > 0)) {
      decimalsByCategory[category] = tokenDecimals;
    }
  }

  return decimalsByCategory;
}

export function isConfirmed(u: UTXO) {
  return typeof u.height === 'number' && u.height > 0;
}

export function sortLargestFirst(pool: UTXO[]) {
  return [...pool].sort((a, b) =>
    Number(BigInt(b.amount ?? b.value) - BigInt(a.amount ?? a.value))
  );
}

export function sumInputsSats(inputs: UTXO[]) {
  return inputs.reduce((s, u) => s + Number(u.amount ?? u.value ?? 0), 0);
}
