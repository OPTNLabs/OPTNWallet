import { TokenMetaMap } from './types';
import { copyToClipboard } from '../../utils/clipboard';
import {
  formatAtomicTokenAmount,
  resolveTokenPresentation,
} from '../../utils/tokenPresentation';

export function copyTextToClipboard(text: string) {
  void copyToClipboard(text);
}

export function formatFtAmount(amount: bigint, decimals: number) {
  return formatAtomicTokenAmount(amount, decimals);
}

export function displayNameFor(cat: string, tokenMeta: TokenMetaMap) {
  return resolveTokenPresentation(cat, tokenMeta[cat]).primaryLabel;
}

export function jsonBigIntReplacer(_k: string, v: unknown) {
  return typeof v === 'bigint' ? v.toString() : v;
}
