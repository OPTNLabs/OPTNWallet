import {
  getBcmrMetadataStatusLabel,
  getBcmrMetadataStatusTone,
  type BcmrTokenMetadataState,
} from '../types/bcmr';
import { shortenHash } from './shortenHash';

export type TokenPresentationStatusTone =
  | 'accent'
  | 'muted'
  | 'warning'
  | 'danger';

export type TokenPresentationFallback = {
  name?: string | null;
  symbol?: string | null;
  decimals?: number | null;
  iconUri?: string | null;
};

export type TokenPresentation = {
  category: string;
  primaryLabel: string;
  secondaryLabel: string | null;
  name: string;
  symbol: string;
  decimals: number;
  iconUri: string | null;
  statusLabel: string | null;
  statusTone: TokenPresentationStatusTone | null;
  hasSnapshot: boolean;
  hasFallback: boolean;
  shortCategory: string;
};

function pickString(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

function pickNumber(...values: Array<number | null | undefined>): number {
  for (const value of values) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    return Math.max(0, Math.trunc(value));
  }
  return 0;
}

export function shortTokenCategory(category: string): string {
  return shortenHash(String(category ?? '').trim(), 4, 4);
}

export function formatAtomicTokenAmount(
  amount: bigint | number | string,
  decimals = 0
): string {
  const normalizedDecimals = Math.max(0, Math.trunc(decimals));
  if (normalizedDecimals <= 0) {
    return typeof amount === 'bigint' ? amount.toString() : String(amount);
  }

  const amountString =
    typeof amount === 'bigint'
      ? amount.toString()
      : typeof amount === 'number'
        ? Number.isFinite(amount)
          ? Math.trunc(amount).toString()
          : '0'
        : String(amount).trim();

  if (!amountString) return '0';

  const isNegative = amountString.startsWith('-');
  const unsigned = isNegative ? amountString.slice(1) : amountString;
  if (!/^\d+$/.test(unsigned)) return '0';

  if (unsigned.length <= normalizedDecimals) {
    const fractional = unsigned.padStart(normalizedDecimals, '0').replace(/0+$/, '');
    return `${isNegative ? '-' : ''}0${fractional ? `.${fractional}` : ''}`;
  }

  const whole = unsigned.slice(0, unsigned.length - normalizedDecimals);
  const fractional = unsigned
    .slice(unsigned.length - normalizedDecimals)
    .replace(/0+$/, '');
  return `${isNegative ? '-' : ''}${whole}${fractional ? `.${fractional}` : ''}`;
}

export function getTokenPresentationStatusClassName(
  tone: TokenPresentationStatusTone
): string {
  switch (tone) {
    case 'accent':
      return 'wallet-accent-text';
    case 'warning':
      return 'wallet-warning-text';
    case 'danger':
      return 'wallet-danger-text';
    case 'muted':
    default:
      return 'wallet-muted';
  }
}

export function resolveTokenPresentation(
  category: string,
  metadata?: Pick<
    BcmrTokenMetadataState,
    | 'status'
    | 'freshness'
    | 'name'
    | 'symbol'
    | 'decimals'
    | 'iconUri'
    | 'snapshot'
    | 'isRefreshing'
  > | null,
  fallback?: TokenPresentationFallback | null
): TokenPresentation {
  const normalizedCategory = String(category ?? '').trim();
  const shortCategory = shortTokenCategory(normalizedCategory);
  const hasSnapshot = Boolean(metadata?.snapshot);
  const hasFallback = Boolean(
    fallback &&
      (fallback.name != null ||
        fallback.symbol != null ||
        fallback.decimals != null ||
        fallback.iconUri != null)
  );

  const fallbackName = pickString(fallback?.name);
  const fallbackSymbol = pickString(fallback?.symbol);
  const fallbackIconUri = pickString(fallback?.iconUri);
  const fallbackDecimals = pickNumber(fallback?.decimals);

  const name = hasSnapshot
    ? pickString(metadata?.name, fallbackName)
    : fallbackName;
  const symbol = hasSnapshot
    ? pickString(metadata?.symbol, fallbackSymbol)
    : fallbackSymbol;
  const decimals = hasSnapshot
    ? pickNumber(metadata?.decimals, fallbackDecimals)
    : fallbackDecimals;
  const iconUri = hasSnapshot
    ? pickString(metadata?.iconUri, fallbackIconUri) || null
    : fallbackIconUri || null;

  const primaryLabel = pickString(name, symbol, shortCategory);
  const secondaryLabel =
    name && symbol && name !== symbol ? symbol : null;

  const shouldShowStatus =
    metadata?.status === 'loading' ||
    metadata?.isRefreshing === true ||
    metadata?.freshness === 'refreshing';
  const statusLabel = shouldShowStatus ? getBcmrMetadataStatusLabel(metadata) : null;
  const statusTone: TokenPresentationStatusTone | null = shouldShowStatus
    ? getBcmrMetadataStatusTone(metadata)
    : null;

  return {
    category: normalizedCategory,
    primaryLabel,
    secondaryLabel,
    name,
    symbol,
    decimals,
    iconUri,
    statusLabel,
    statusTone,
    hasSnapshot,
    hasFallback,
    shortCategory,
  };
}
