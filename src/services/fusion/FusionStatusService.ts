// Shared default: on mobile/web there is no way to speak CashFusion at all.
// The protocol needs a raw TCP+TLS socket, which a browser/WebView cannot open
// — so this is not a "not implemented yet" stub, it is a platform limit.
// The desktop build swaps this for the real Rust-backed client via
// vite.desktop.config.ts's module-swap plugin.

export type FusionServerStatus = {
  tiers: number[];
  numComponents: number;
  componentFeerate: number;
  minExcessFee: number;
  maxExcessFee: number;
  donationAddress: string | null;
};

/** SOCKS5 proxy to route the connection through (Tor). */
export type TorConfig = { host: string; port: number };

export const FUSION_SUPPORTED = false;

export async function fetchFusionServerStatus(
  _host: string,
  _port: number,
  _useSsl: boolean,
  _tor?: TorConfig
): Promise<FusionServerStatus> {
  void _host;
  void _port;
  void _useSsl;
  void _tor;
  throw new Error(
    'CashFusion needs a raw TCP connection, which this platform cannot open. Use the desktop app.'
  );
}

export async function detectTorPort(_host?: string): Promise<number | null> {
  void _host;
  return null;
}

export async function checkTorPort(_host: string, _port: number): Promise<boolean> {
  void _host;
  void _port;
  return false;
}

export type ManagedTorStatus = { running: boolean; bootstrap_percent: number; socks_port: number };

// Integrated Tor is desktop-only (it spawns a real process). The shared default
// reports it as unsupported/not-running.
export const INTEGRATED_TOR_SUPPORTED = false;

export async function startIntegratedTor(): Promise<number> {
  throw new Error('Integrated Tor is only available in the desktop app.');
}

export async function stopIntegratedTor(): Promise<void> {
  /* no-op */
}

export async function integratedTorStatus(): Promise<ManagedTorStatus> {
  return { running: false, bootstrap_percent: 0, socks_port: 0 };
}
