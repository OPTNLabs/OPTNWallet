export interface FusionModeAvailabilityOptions {
  p2pFusionEnabled: boolean;
  walletId: number;
  serverBusy: boolean;
}

export interface FusionModeAvailability {
  serverDisabled: boolean;
  serverMuted: boolean;
}

/**
 * Server Fusion and P2P Fusion are two transports for one feature. Only the
 * selected transport may start a round, and the inactive card is visually
 * muted so the UI and the execution path cannot disagree.
 */
export function getFusionModeAvailability(
  options: FusionModeAvailabilityOptions
): FusionModeAvailability {
  return {
    serverDisabled:
      options.p2pFusionEnabled || options.serverBusy || options.walletId <= 0,
    serverMuted: options.p2pFusionEnabled,
  };
}

/** Defense in depth for callers that bypass or race the disabled UI control. */
export function assertServerFusionSelected(p2pFusionEnabled: boolean): void {
  if (p2pFusionEnabled) {
    throw new Error(
      'Server Fusion is unavailable while P2P Fusion is selected.'
    );
  }
}
