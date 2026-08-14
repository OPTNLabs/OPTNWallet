import * as bip39 from 'bip39';
import type { SupportedLocale } from '../i18n/types';

export type Bip39Language = 'english';

export const BIP39_WORD_COUNTS = [12, 15, 18, 21, 24] as const;
export type Bip39WordCount = (typeof BIP39_WORD_COUNTS)[number];
export const DEFAULT_BIP39_WORD_COUNT: Bip39WordCount = 12;

export function getBip39LanguageForLocale(
  locale: SupportedLocale
): Bip39Language {
  // OPTN deliberately uses the English BIP39 list for every UI locale.
  // Non-English mnemonic lists are discouraged by the BIP39 specification.
  void locale;
  return 'english';
}

const WORDLISTS: Record<Bip39Language, typeof bip39.wordlists.english> = {
  english: bip39.wordlists.english,
};

export const BIP39_IMPORT_ERROR =
  'Enter a valid English BIP39 recovery phrase with 12, 15, 18, 21, or 24 words.';

export function normalizeBip39Mnemonic(mnemonic: string): string {
  return mnemonic.normalize('NFKD').trim().toLowerCase().split(/\s+/).join(' ');
}

export function generateBip39Mnemonic(
  language: Bip39Language = 'english'
): string {
  return bip39.generateMnemonic(128, undefined, WORDLISTS[language]);
}

export function detectBip39Language(mnemonic: string): Bip39Language | null {
  const normalized = normalizeBip39Mnemonic(mnemonic);
  if (!isSupportedWordCount(normalized.split(' ').length)) return null;

  for (const language of Object.keys(WORDLISTS) as Bip39Language[]) {
    if (bip39.validateMnemonic(normalized, WORDLISTS[language]))
      return language;
  }
  return null;
}

export function isValidBip39Mnemonic(
  mnemonic: string,
  language?: Bip39Language
): boolean {
  const normalized = normalizeBip39Mnemonic(mnemonic);
  if (!isSupportedWordCount(normalized.split(' ').length)) return false;
  if (language) return bip39.validateMnemonic(normalized, WORDLISTS[language]);
  return detectBip39Language(normalized) !== null;
}

function isSupportedWordCount(value: number): value is Bip39WordCount {
  return (BIP39_WORD_COUNTS as readonly number[]).includes(value);
}
