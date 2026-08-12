type HasWalletBiometric = (walletId: number) => Promise<boolean>;

/**
 * Resolve which open prompt may offer biometric unlock. Availability and the
 * selected wallet arrive independently, so callers must rerun this whenever
 * either value changes rather than treating an early unavailable state as a
 * permanent negative enrollment result.
 */
export async function resolveBiometricEnrollment(
  walletId: number | null,
  biometricAvailable: boolean,
  hasWalletBiometric: HasWalletBiometric
): Promise<number | null> {
  if (!biometricAvailable || walletId == null) return null;
  return (await hasWalletBiometric(walletId)) ? walletId : null;
}
