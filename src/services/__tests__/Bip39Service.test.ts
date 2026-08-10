import { describe, expect, it } from 'vitest';
import * as bip39 from 'bip39';
import {
  detectBip39Language,
  generateBip39Mnemonic,
  getBip39LanguageForLocale,
  isValidBip39Mnemonic,
  normalizeBip39Mnemonic,
} from '../Bip39Service';

const VALID_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('Bip39Service', () => {
  it('accepts a checksum-valid English 12-word mnemonic', () => {
    expect(isValidBip39Mnemonic(VALID_MNEMONIC)).toBe(true);
    expect(detectBip39Language(VALID_MNEMONIC)).toBe('english');
  });

  it.each([
    [12, 16],
    [15, 20],
    [18, 24],
    [21, 28],
    [24, 32],
  ] as const)(
    'accepts a checksum-valid %s-word mnemonic',
    (wordCount, bytes) => {
      const mnemonic = bip39.entropyToMnemonic('0'.repeat(bytes * 2));
      expect(mnemonic.split(' ')).toHaveLength(wordCount);
      expect(isValidBip39Mnemonic(mnemonic)).toBe(true);
    }
  );

  it('generates and validates an English mnemonic', () => {
    const mnemonic = generateBip39Mnemonic('english');
    expect(isValidBip39Mnemonic(mnemonic, 'english')).toBe(true);
    expect(detectBip39Language(mnemonic)).toBe('english');
  });

  it.each([
    ['en', 'english'],
    ['es', 'english'],
    ['pt-BR', 'english'],
    ['zh-CN', 'english'],
    ['zh-TW', 'english'],
    ['fr', 'english'],
    ['ko', 'english'],
    ['ja', 'english'],
    ['vi', 'english'],
    ['ar', 'english'],
    ['ru', 'english'],
    ['ha-NG', 'english'],
  ] as const)(
    'maps %s UI locale to its available BIP39 wordlist',
    (locale, expected) => {
      expect(getBip39LanguageForLocale(locale)).toBe(expected);
    }
  );

  it('normalizes whitespace, case, and Unicode compatibility form', () => {
    expect(normalizeBip39Mnemonic('  ABANDON\n abandon   ABOUT  ')).toBe(
      'abandon abandon about'
    );
  });

  it('rejects an unknown word', () => {
    expect(
      isValidBip39Mnemonic(
        VALID_MNEMONIC.replace('about', 'not-in-the-wordlist')
      )
    ).toBe(false);
  });

  it('rejects a wordlist-valid phrase with an invalid checksum', () => {
    const generated = bip39.entropyToMnemonic('0'.repeat(32));
    const words = generated.split(' ');
    words[11] = words[11] === 'about' ? 'abandon' : 'about';
    expect(isValidBip39Mnemonic(words.join(' '))).toBe(false);
  });

  it('rejects unsupported phrase lengths', () => {
    expect(isValidBip39Mnemonic(`${VALID_MNEMONIC} abandon`)).toBe(false);
  });
});
