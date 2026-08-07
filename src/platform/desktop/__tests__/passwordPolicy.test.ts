import { describe, expect, it } from 'vitest';
import {
  MIN_WALLET_PASSWORD_LENGTH,
  isWalletPasswordLongEnough,
  validateNewWalletPassword,
  walletPasswordTooShortMessage,
} from '../passwordPolicy';

describe('passwordPolicy (desktop min 8)', () => {
  it('rejects blank and short passwords', () => {
    expect(isWalletPasswordLongEnough('')).toBe(false);
    expect(isWalletPasswordLongEnough('1234567')).toBe(false);
    expect(isWalletPasswordLongEnough('12345678')).toBe(true);
    expect(MIN_WALLET_PASSWORD_LENGTH).toBe(8);
  });

  it('validateNewWalletPassword checks length and confirm', () => {
    expect(validateNewWalletPassword('short')).toBe(walletPasswordTooShortMessage());
    expect(validateNewWalletPassword('long-enough', 'mismatch')).toBe(
      'Passwords do not match.'
    );
    expect(validateNewWalletPassword('long-enough', 'long-enough')).toBeNull();
  });
});
