// Desktop CashFusion status client — swapped in for
// src/services/fusion/FusionStatusService.ts by vite.desktop.config.ts.
//
// Calls the Rust `fusion_server_status` command, which performs a real
// CashFusion protocol handshake (ClientHello -> ServerHello) over TCP+TLS —
// optionally through a Tor SOCKS5 proxy — and returns the server's actual
// fusion parameters. Read-only: it joins no pool and signs nothing.

import { invoke } from '@tauri-apps/api/core';
import type {
  FusionServerStatus,
  TorConfig,
} from '../../services/fusion/FusionStatusService';

export const FUSION_SUPPORTED = true;

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
  useSsl: boolean,
  tor?: TorConfig
): Promise<FusionServerStatus> {
  const raw = await invoke<RawStatus>('fusion_server_status', {
    host,
    port,
    useSsl,
    torHost: tor?.host ?? null,
    torPort: tor?.port ?? null,
  });
  return {
    tiers: raw.tiers,
    numComponents: raw.num_components,
    componentFeerate: raw.component_feerate,
    minExcessFee: raw.min_excess_fee,
    maxExcessFee: raw.max_excess_fee,
    donationAddress: raw.donation_address,
  };
}

/** Auto-detect a running Tor SOCKS proxy (ports 9050/9150). null if not found. */
export async function detectTorPort(host?: string): Promise<number | null> {
  return invoke<number | null>('fusion_tor_detect', { host: host ?? null });
}

/** Verify a specific host:port is genuinely a Tor proxy. */
export async function checkTorPort(host: string, port: number): Promise<boolean> {
  return invoke<boolean>('fusion_tor_check', { host, port });
}

export type ManagedTorStatus = { running: boolean; bootstrap_percent: number; socks_port: number };

/** Start the app's integrated Tor and wait for bootstrap. Returns SOCKS port. */
export async function startIntegratedTor(): Promise<number> {
  return invoke<number>('tor_start');
}

/** Stop the app's integrated Tor. */
export async function stopIntegratedTor(): Promise<void> {
  await invoke('tor_stop');
}

/** Status of the app's integrated Tor. */
export async function integratedTorStatus(): Promise<ManagedTorStatus> {
  return invoke<ManagedTorStatus>('tor_status');
}

export const INTEGRATED_TOR_SUPPORTED = true;

/**
 * App-managed Tor SOCKS port (must match INTEGRATED_TOR_SOCKS_PORT in lib.rs).
 * Not 9050/9150 so it does not clash with system Tor Browser / daemon.
 */
export const INTEGRATED_TOR_SOCKS_PORT = 9251;

export type { FusionServerStatus, TorConfig };
