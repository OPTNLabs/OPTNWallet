// User-added Electrum/Fulcrum servers, persisted per network.
//
// Stored in localStorage (synchronously readable) rather than redux so the
// pure server-pool functions in InfraUrls.ts can include them without a store
// dependency. Accepts a bare "host:port" or "host" (any hostname or IP,
// including a LAN address like 192.168.0.129:50002 for a self-hosted Fulcrum).

import { Network } from '../../state/slices/networkSlice';

const KEY_PREFIX = 'optn.electrum.user-servers.';

function keyFor(network: Network): string {
  return `${KEY_PREFIX}${network}`;
}

function safeParse(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

export function getUserServers(network: Network): string[] {
  if (typeof localStorage === 'undefined') return [];
  return safeParse(localStorage.getItem(keyFor(network)));
}

function write(network: Network, servers: string[]): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(keyFor(network), JSON.stringify(servers));
}

/** Basic host:port validation. Accepts hostnames and IPv4, optional port. */
export function isValidServerEntry(entry: string): boolean {
  const trimmed = entry.trim().replace(/^wss?:\/\//i, '');
  if (!trimmed) return false;
  const [host, port] = trimmed.split(':');
  if (!host) return false;
  // host: hostname or IPv4 (loose — the connection attempt is the real check).
  const hostOk = /^[a-zA-Z0-9.-]+$/.test(host);
  const portOk = port === undefined || /^\d{1,5}$/.test(port);
  return hostOk && portOk;
}

export function addUserServer(network: Network, entry: string): string[] {
  const cleaned = entry.trim().replace(/^wss?:\/\//i, '');
  const servers = getUserServers(network);
  if (cleaned && !servers.includes(cleaned)) {
    servers.push(cleaned);
    write(network, servers);
  }
  return servers;
}

export function removeUserServer(network: Network, entry: string): string[] {
  const servers = getUserServers(network).filter((s) => s !== entry);
  write(network, servers);
  return servers;
}
