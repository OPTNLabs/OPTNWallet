import { describe, expect, it } from 'vitest';
import {
  MIN_WALLET_PASSWORD_LENGTH,
  isWalletPasswordAcceptable,
  isWalletPasswordLongEnough,
  validateNewWalletPassword,
  walletPasswordTooShortMessage,
} from '../passwordPolicy';

describe('passwordPolicy (empty or min 8)', () => {
  it('accepts empty or ≥8; rejects 1–7', () => {
    expect(isWalletPasswordAcceptable('')).toBe(true);
    expect(isWalletPasswordAcceptable('1234567')).toBe(false);
    expect(isWalletPasswordAcceptable('12345678')).toBe(true);
    expect(isWalletPasswordLongEnough('')).toBe(false);
    expect(isWalletPasswordLongEnough('12345678')).toBe(true);
    expect(MIN_WALLET_PASSWORD_LENGTH).toBe(8);
  });

  it('validateNewWalletPassword checks policy and confirm', () => {
    expect(validateNewWalletPassword('')).toBeNull();
    expect(validateNewWalletPassword('', '')).toBeNull();
    expect(validateNewWalletPassword('short')).toBe(
      walletPasswordTooShortMessage()
    );
    expect(validateNewWalletPassword('long-enough', 'mismatch')).toBe(
      'Passwords do not match.'
    );
    expect(validateNewWalletPassword('long-enough', 'long-enough')).toBeNull();
  });
});
