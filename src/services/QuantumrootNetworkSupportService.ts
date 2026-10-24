import { Network } from '../state/slices/networkSlice';
import { networkProfile } from '../utils/networkProfile';

// BCH upgrades activate network-wide on May 15; BCH upgrades conventionally
// activate at 12:00 UTC, so we gate active mainnet Quantumroot flows from then.
export const QUANTUMROOT_MAINNET_ACTIVATION_AT = new Date(
  '2026-05-15T12:00:00.000Z'
);

export type QuantumrootNetworkSupport = {
  activationAt: Date | null;
  isActive: boolean;
  isPreviewOnly: boolean;
  canReceiveOnChain: boolean;
  statusLabel: string;
};

export function getQuantumrootNetworkSupport(
  network: Network,
  now = new Date()
): QuantumrootNetworkSupport {
  if (network !== Network.MAINNET && network !== Network.CHIPNET) {
    return {
      activationAt: null,
      isActive: false,
      isPreviewOnly: false,
      canReceiveOnChain: false,
      statusLabel: `Not available on ${networkProfile(network).label}`,
    };
  }
  if (network === Network.CHIPNET) {
    return {
      activationAt: null,
      isActive: true,
      isPreviewOnly: false,
      canReceiveOnChain: true,
      statusLabel: 'Active on Chipnet',
    };
  }

  const isActive = now.getTime() >= QUANTUMROOT_MAINNET_ACTIVATION_AT.getTime();
  return {
    activationAt: QUANTUMROOT_MAINNET_ACTIVATION_AT,
    isActive,
    isPreviewOnly: !isActive,
    canReceiveOnChain: isActive,
    statusLabel: isActive ? 'Active on Mainnet' : 'Preview on Mainnet',
  };
}
