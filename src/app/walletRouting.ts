import { WalletType, type ExtendedWalletType } from '../types/wallet';

export type SendSurface = 'multisig' | 'watch-only' | 'simple';

/**
 * Keep the air-gapped multisig coordinator opt-in by wallet type.
 *
 * In particular, `hardware` must continue through the existing live-device
 * send surface. SeedSigner-style hardware integrations must never be routed
 * through the BCH multisig PSBT coordinator merely because they expose an
 * xpub or PSBT transport.
 */
export function sendSurfaceForWalletType(
  walletType: ExtendedWalletType
): SendSurface {
  if (walletType === WalletType.MULTISIG) return 'multisig';
  if (walletType === 'watch-only') return 'watch-only';
  return 'simple';
}
