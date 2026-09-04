import { describe, expect, it } from 'vitest';

import { WalletType } from '../../types/wallet';
import { sendSurfaceForWalletType } from '../walletRouting';

describe('wallet send routing', () => {
  it('uses the shared multisig coordinator only for multisig wallets', () => {
    expect(sendSurfaceForWalletType(WalletType.MULTISIG)).toBe('multisig');
  });

  it('keeps watch-only air-gap wallets on the legacy-compatible PSBT surface', () => {
    expect(sendSurfaceForWalletType('watch-only')).toBe('watch-only');
  });

  it('keeps hardware wallets on the existing live-device surface', () => {
    expect(sendSurfaceForWalletType('hardware')).toBe('simple');
  });

  it('keeps standard wallets on the ordinary signer surface', () => {
    expect(sendSurfaceForWalletType(WalletType.STANDARD)).toBe('simple');
  });
});
