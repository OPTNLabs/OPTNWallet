import { TokenMetaMap } from './types';
import { copyToClipboard } from '../../utils/clipboard';

export function copyTextToClipboard(text: string) {
  void copyToClipboard(text);
}

export function formatFtAmount(amount: bigint, decimals: number) {
  const s = amount.toString();
  if (decimals <= 0) return s;
  if (s.length <= decimals) {
    const frac = s.padStart(decimals, '0').replace(/0+$/, '');
    return `0.${frac || '0'}`;
  }
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

export function displayNameFor(cat: string, tokenMeta: TokenMetaMap) {
  const m = tokenMeta[cat];
  if (!m) return `${cat.slice(0, 8)}…`;
  if (m.name && m.symbol) return `${m.name} (${m.symbol})`;
  if (m.name) return m.name;
  if (m.symbol) return m.symbol;
  return `${cat.slice(0, 8)}…`;
}

export function jsonBigIntReplacer(_k: string, v: unknown) {
  return typeof v === 'bigint' ? v.toString() : v;
}
