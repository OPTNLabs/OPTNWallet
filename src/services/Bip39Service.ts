import type { SupportedLocale } from '../i18n/types';
// Mnemonics are made, checked and hashed by crates/optn-core (src/hd.rs), the
// same code the CLI and the desktop runtime use. Only the randomness and the
// Unicode normalization stay here, because JS has both built in.
import {
  bip39IsCanonicalMnemonic,
  bip39MnemonicFromEntropy,
  bip39Seed,
  ensureOptnCore,
} from '../wasm/optn-core';

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

export const BIP39_IMPORT_ERROR =
  'Enter a valid English BIP39 recovery phrase with 12, 15, 18, 21, or 24 words.';

export function normalizeBip39Mnemonic(mnemonic: string): string {
  return mnemonic.normalize('NFKD').trim().toLowerCase().split(/\s+/).join(' ');
}

/** 128 bits of entropy: the wallet's default 12-word phrase. */
const DEFAULT_ENTROPY_BYTES = 16;

export function generateBip39Mnemonic(
  language: Bip39Language = 'english'
): string {
  void language; // English is the only list; see getBip39LanguageForLocale.
  const entropy = crypto.getRandomValues(new Uint8Array(DEFAULT_ENTROPY_BYTES));
  try {
    ensureOptnCore();
    return bip39MnemonicFromEntropy(entropy);
  } finally {
    entropy.fill(0);
  }
}

/**
 * Whether the text is a valid English BIP39 phrase written exactly as BIP39
 * writes one, after NFKD (what bip39.js's validateMnemonic accepted). The
 * seed is hashed from the text as given, so a phrase that passes here is the
 * one its seed comes from; callers that accept looser input normalize first.
 */
export function isCanonicalBip39Mnemonic(mnemonic: string): boolean {
  ensureOptnCore();
  return bip39IsCanonicalMnemonic(mnemonic.normalize('NFKD'));
}

/**
 * The 64-byte BIP39 seed of a phrase and passphrase, both taken as given
 * (after NFKD), as bip39.js's mnemonicToSeed computed it. For keys that are
 * not BIP32, such as MLS's HPKE inputs. The caller wipes the result.
 */
export function bip39SeedFromMnemonic(
  mnemonic: string,
  passphrase = ''
): Uint8Array {
  ensureOptnCore();
  return bip39Seed(mnemonic.normalize('NFKD'), passphrase.normalize('NFKD'));
}

export function detectBip39Language(mnemonic: string): Bip39Language | null {
  const normalized = normalizeBip39Mnemonic(mnemonic);
  if (!isSupportedWordCount(normalized.split(' ').length)) return null;
  return isCanonicalBip39Mnemonic(normalized) ? 'english' : null;
}

export function isValidBip39Mnemonic(
  mnemonic: string,
  language?: Bip39Language
): boolean {
  void language; // Every supported language is English.
  return detectBip39Language(mnemonic) !== null;
}

function isSupportedWordCount(value: number): value is Bip39WordCount {
  return (BIP39_WORD_COUNTS as readonly number[]).includes(value);
}
