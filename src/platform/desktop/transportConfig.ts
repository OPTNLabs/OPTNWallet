// Process-wide transport configuration — Electron Cash's global config tier.
//
// EC keeps `cashfusion_server`, `cashfusion_tor_host` and `cashfusion_tor_port`
// in the app config, not the wallet file, because they describe how the PROCESS
// reaches the network rather than anything about a wallet. Ours sat in the
// experimental redux slice alongside per-wallet policy, so redux-persist wrote
// them into the per-window partition: every new window started with default
// relays and a default Tor port, and configuring them in one window left the
// others unchanged.
//
// The mismatch was already visible in the split it created. The Tor PROCESS is
// genuinely process-global — the Rust side keeps RUNNING and SOCKS_PORT in
// atomics, which is why an orphaned tor can be adopted at all — while the
// SETTINGS describing it were per-window. One of those had to move; this is the
// one that was wrong.

import { getLocalStorage } from '../../utils/browserStorage';

const TRANSPORT_KEY = 'optn-transport-config';

export interface TransportConfig {
  torEnabled: boolean;
  torAuto: boolean;
  torHost: string;
  torPortManual: number;
  fusionServer: string;
  fusionServers: string[];
  nostrRelays: string[];
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => typeof entry === 'string' && entry.length > 0)
  );
}

/**
 * Stored transport config, or null when nothing has been saved yet.
 *
 * Null rather than defaults on purpose: the caller already holds the redux
 * defaults, and inventing them here would let this module silently overwrite a
 * first-run configuration with its own idea of the defaults.
 */
export function readTransportConfig(): Partial<TransportConfig> | null {
  try {
    const raw = getLocalStorage()?.getItem(TRANSPORT_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const stored = parsed as Record<string, unknown>;
    const out: Partial<TransportConfig> = {};

    if (typeof stored.torEnabled === 'boolean') out.torEnabled = stored.torEnabled;
    if (typeof stored.torAuto === 'boolean') out.torAuto = stored.torAuto;
    if (typeof stored.torHost === 'string' && stored.torHost) {
      out.torHost = stored.torHost;
    }
    // A port of 0 is not "unset" here — it is a value that would silently route
    // Tor traffic nowhere, so only a usable port is accepted.
    if (
      typeof stored.torPortManual === 'number' &&
      Number.isInteger(stored.torPortManual) &&
      stored.torPortManual > 0 &&
      stored.torPortManual <= 65535
    ) {
      out.torPortManual = stored.torPortManual;
    }
    if (typeof stored.fusionServer === 'string' && stored.fusionServer) {
      out.fusionServer = stored.fusionServer;
    }
    if (isNonEmptyStringArray(stored.fusionServers)) {
      out.fusionServers = stored.fusionServers;
    }
    // An empty relay list would leave P2P fusion unable to find any peer, which
    // presents as "no peers" rather than as a broken setting. Reject it.
    if (isNonEmptyStringArray(stored.nostrRelays)) {
      out.nostrRelays = stored.nostrRelays;
    }
    return out;
  } catch {
    return null;
  }
}

export function writeTransportConfig(config: TransportConfig): void {
  try {
    getLocalStorage()?.setItem(TRANSPORT_KEY, JSON.stringify(config));
  } catch {
    /* storage unavailable — settings stay per-session */
  }
}
