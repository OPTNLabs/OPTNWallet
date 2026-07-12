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

export const FUSION_SUPPORTED = false;

export async function fetchFusionServerStatus(
  _host: string,
  _port: number,
  _useSsl: boolean
): Promise<FusionServerStatus> {
  void _host;
  void _port;
  void _useSsl;
  throw new Error(
    'CashFusion needs a raw TCP connection, which this platform cannot open. Use the desktop app.'
  );
}
