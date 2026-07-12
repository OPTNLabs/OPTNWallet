// Desktop CashFusion status client — swapped in for
// src/services/fusion/FusionStatusService.ts by vite.desktop.config.ts.
//
// Calls the Rust `fusion_server_status` command, which performs a real
// CashFusion protocol handshake (ClientHello -> ServerHello) over TCP+TLS and
// returns the server's actual fusion parameters. Read-only: it joins no pool
// and signs nothing, so it cannot touch funds.

import { invoke } from '@tauri-apps/api/core';
import type { FusionServerStatus } from '../../services/fusion/FusionStatusService';

export const FUSION_SUPPORTED = true;

// Field names as emitted by serde from the Rust FusionServerStatus struct.
type RawStatus = {
  tiers: number[];
  num_components: number;
  component_feerate: number;
  min_excess_fee: number;
  max_excess_fee: number;
  donation_address: string | null;
};

export async function fetchFusionServerStatus(
  host: string,
  port: number,
  useSsl: boolean
): Promise<FusionServerStatus> {
  const raw = await invoke<RawStatus>('fusion_server_status', { host, port, useSsl });
  return {
    tiers: raw.tiers,
    numComponents: raw.num_components,
    componentFeerate: raw.component_feerate,
    minExcessFee: raw.min_excess_fee,
    maxExcessFee: raw.max_excess_fee,
    donationAddress: raw.donation_address,
  };
}

export type { FusionServerStatus };
