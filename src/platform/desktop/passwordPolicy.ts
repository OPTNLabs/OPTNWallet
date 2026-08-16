/**
 * Desktop wallet password policy (Electron Cash–style).
 *
 * - Empty string = no password (allowed).
 * - Non-empty must be at least MIN_WALLET_PASSWORD_LENGTH characters.
 * - Lengths 1 .. MIN-1 are rejected (not strong enough, not “no password”).
 */

export const MIN_WALLET_PASSWORD_LENGTH = 8;

/** True when the password is long enough to count as a real password (≥ min). */
export function isWalletPasswordLongEnough(password: string): boolean {
  return (
    typeof password === 'string' && password.length >= MIN_WALLET_PASSWORD_LENGTH
  );
}

/**
 * True when the password may be used for create / import / protect:
 * empty (no password) or at least MIN characters.
 */
export function isWalletPasswordAcceptable(password: string): boolean {
  if (typeof password !== 'string') return false;
  if (password.length === 0) return true;
  return password.length >= MIN_WALLET_PASSWORD_LENGTH;
}

/** Human message for setup / change / protect flows. */
export function walletPasswordTooShortMessage(
  min: number = MIN_WALLET_PASSWORD_LENGTH
): string {
  return `Leave empty for no password, or use at least ${min} characters.`;
}

/**
 * Validate a new password (create, import, change, public-key protect).
 * Returns an error string, or null if OK.
 */
export function validateNewWalletPassword(
  password: string,
  confirm?: string
): string | null {
  if (!isWalletPasswordAcceptable(password)) {
    return walletPasswordTooShortMessage();
  }
  if (confirm !== undefined && password !== confirm) {
    return 'Passwords do not match.';
  }
  return null;
}
