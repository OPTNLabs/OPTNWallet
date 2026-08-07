/**
 * Desktop wallet password policy (matches extension gate: min 8).
 *
 * Blank passwords are no longer accepted: they left .optn / DB ciphertext
 * effectively open at rest (PBKDF2 of empty string + salt on disk).
 */

export const MIN_WALLET_PASSWORD_LENGTH = 8;

export function isWalletPasswordLongEnough(password: string): boolean {
  return typeof password === 'string' && password.length >= MIN_WALLET_PASSWORD_LENGTH;
}

/** Human message for setup / change / protect flows. */
export function walletPasswordTooShortMessage(
  min: number = MIN_WALLET_PASSWORD_LENGTH
): string {
  return `Use at least ${min} characters.`;
}

/**
 * Validate a new password (create, import, change, public-key protect).
 * Returns an error string, or null if OK.
 */
export function validateNewWalletPassword(
  password: string,
  confirm?: string
): string | null {
  if (!isWalletPasswordLongEnough(password)) {
    return walletPasswordTooShortMessage();
  }
  if (confirm !== undefined && password !== confirm) {
    return 'Passwords do not match.';
  }
  return null;
}
