// A CashFusion server address as the holder types it: `host[:port][:s|:t]`.
// The Rust side parses the same form (`ServerTarget::parse`) for the round
// itself; this is for the server query and the panel's labels.

import { isLocalFusionDestination } from './FusionTorResolver';

export interface FusionServerTarget {
  host: string;
  port: number;
  useSsl: boolean;
}

export function parseFusionServerTarget(server: string): FusionServerTarget {
  const token = server.trim().split(/\s+/)[0] ?? '';
  const match = /^([^:\s]+)(?::(\d+))?(?::([st]))?$/.exec(token);
  if (!match) throw new Error('CashFusion server address is invalid.');
  const port = match[2] === undefined ? 8789 : Number(match[2]);
  if (!match[1] || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('CashFusion server address is invalid.');
  }
  const host = match[1];
  const explicitScheme = match[3];
  return {
    host,
    port,
    // Electron Cash's server.py speaks PLAIN TCP — it has no TLS of its own;
    // the public servers are fronted by something else that terminates it. So
    // defaulting every address to SSL made a local server unreachable, and the
    // failure was "TLS handshake failed: tls handshake eof", which reads as a
    // broken server rather than as us speaking the wrong protocol at it.
    //
    // A remote server still defaults to SSL, because sending fusion traffic to
    // the internet in the clear is the worse mistake. An explicit `:s` or `:t`
    // suffix always wins over both defaults.
    useSsl: explicitScheme
      ? explicitScheme === 's'
      : !isLocalFusionDestination(host),
  };
}
