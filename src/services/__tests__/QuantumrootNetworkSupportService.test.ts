import { describe, expect, it } from 'vitest';

import { Network } from '../../redux/networkSlice';
import {
  QUANTUMROOT_MAINNET_ACTIVATION_AT,
  getQuantumrootNetworkSupport,
} from '../QuantumrootNetworkSupportService';

describe('QuantumrootNetworkSupportService', () => {
  it('treats chipnet as active', () => {
    const support = getQuantumrootNetworkSupport(
      Network.CHIPNET,
      new Date('2026-04-12T12:00:00.000Z')
    );

    expect(support.isActive).toBe(true);
    expect(support.isPreviewOnly).toBe(false);
    expect(support.canReceiveOnChain).toBe(true);
    expect(support.activationAt).toBe(null);
  });

  it('treats mainnet as preview-only before activation', () => {
    const support = getQuantumrootNetworkSupport(
      Network.MAINNET,
      new Date('2026-04-12T12:00:00.000Z')
    );

    expect(support.isActive).toBe(false);
    expect(support.isPreviewOnly).toBe(true);
    expect(support.canReceiveOnChain).toBe(false);
    expect(support.activationAt?.toISOString()).toBe(
      QUANTUMROOT_MAINNET_ACTIVATION_AT.toISOString()
    );
  });

  it('treats mainnet as active at and after activation', () => {
    const support = getQuantumrootNetworkSupport(
      Network.MAINNET,
      new Date(QUANTUMROOT_MAINNET_ACTIVATION_AT)
    );

    expect(support.isActive).toBe(true);
    expect(support.isPreviewOnly).toBe(false);
    expect(support.canReceiveOnChain).toBe(true);
  });
});
