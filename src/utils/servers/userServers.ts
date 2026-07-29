// User-added Electrum/Fulcrum servers, persisted per network.
//
// Stored in localStorage (synchronously readable) rather than redux so the
// pure server-pool functions in InfraUrls.ts can include them without a store
// dependency. Accepts a bare "host:port" or "host" (any hostname or IP,
// including a LAN address like 192.168.0.129:50002 for a self-hosted Fulcrum).

import { Network } from '../../state/slices/networkSlice';

const KEY_PREFIX = 'optn.electrum.user-servers.';
const LABEL_KEY_PREFIX = 'optn.electrum.server-labels.';

function keyFor(network: Network): string {
  return `${KEY_PREFIX}${network}`;
}

function labelKeyFor(network: Network): string {
  return `${LABEL_KEY_PREFIX}${network}`;
}

// A user entry is "host:port" with an optional display label after whitespace,
// e.g. "192.168.0.129:50002 My Fulcrum". The connection target is only the
// host:port; the label is display-only metadata so the pool/adapter never see
// it. Returns { target, label? }.
export function parseServerEntry(entry: string): { target: string; label?: string } {
  const trimmed = entry.trim().replace(/^wss?:\/\//i, '');
  const match = trimmed.match(/^(\S+)\s+(.+)$/);
  if (match) return { target: match[1], label: match[2].trim() };
  return { target: trimmed };
}

function readLabels(network: Network): Record<string, string> {
  if (typeof localStorage === 'undefined') return {};
  try {
    const parsed = JSON.parse(localStorage.getItem(labelKeyFor(network)) ?? '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function writeLabels(network: Network, labels: Record<string, string>): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(labelKeyFor(network), JSON.stringify(labels));
}

/** Display label for a server target, or undefined if none was set. */
export function getServerLabel(network: Network, target: string): string | undefined {
  return readLabels(network)[target];
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

/** Validates the host:port target of an entry (an optional label is ignored). */
export function isValidServerEntry(entry: string): boolean {
  const { target } = parseServerEntry(entry);
  if (!target) return false;
  const [host, port] = target.split(':');
  if (!host) return false;
  // host: hostname or IPv4 (loose — the connection attempt is the real check).
  const hostOk = /^[a-zA-Z0-9.-]+$/.test(host);
  const portOk = port === undefined || /^\d{1,5}$/.test(port);
  return hostOk && portOk;
}

export function addUserServer(network: Network, entry: string): string[] {
  const { target, label } = parseServerEntry(entry);
  const servers = getUserServers(network);
  if (target && !servers.includes(target)) {
    servers.push(target);
    write(network, servers);
  }
  if (target && label) {
    const labels = readLabels(network);
    labels[target] = label;
    writeLabels(network, labels);
  }
  return servers;
}

export function removeUserServer(network: Network, target: string): string[] {
  const servers = getUserServers(network).filter((s) => s !== target);
  write(network, servers);
  const labels = readLabels(network);
  if (labels[target]) {
    delete labels[target];
    writeLabels(network, labels);
  }
  return servers;
}
