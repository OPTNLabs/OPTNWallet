export function parseDecimalToAtomic(
  value: string,
  decimals: number
): bigint | null {
  const normalized = value.trim();
  if (!normalized) return null;
  const pattern = new RegExp(`^\\d+(\\.\\d{0,${Math.max(0, decimals)}})?$`);
  if (!pattern.test(normalized)) return null;
  const [whole, frac = ''] = normalized.split('.');
  return (
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt((frac + '0'.repeat(decimals)).slice(0, decimals) || '0')
  );
}

export function parseBchInputToSats(value: string): bigint | null {
  return parseDecimalToAtomic(value, 8);
}

export function sanitizeDecimalInput(
  value: string,
  decimals: number,
  maxAtomic?: bigint | null,
  formatAtomic?: (value: bigint, decimals: number) => string
): string {
  let sanitized = value.replace(/,/g, '.').replace(/[^0-9.]/g, '');
  const firstDot = sanitized.indexOf('.');
  if (firstDot !== -1) {
    sanitized =
      sanitized.slice(0, firstDot + 1) +
      sanitized
        .slice(firstDot + 1)
        .replace(/\./g, '')
        .slice(0, Math.max(0, decimals));
  }

  if (sanitized.startsWith('.')) {
    sanitized = `0${sanitized}`;
  }

  const parsed = parseDecimalToAtomic(sanitized, decimals);
  if (maxAtomic != null && parsed != null && parsed > maxAtomic) {
    return formatAtomic ? formatAtomic(maxAtomic, decimals) : sanitized;
  }

  return sanitized;
}

export function selectExecutableSwapMaxAtomic(params: {
  walletMaxAtomic: bigint;
  routableMaxAtomic: bigint;
}): bigint {
  const { walletMaxAtomic, routableMaxAtomic } = params;
  return walletMaxAtomic < routableMaxAtomic ? walletMaxAtomic : routableMaxAtomic;
}
