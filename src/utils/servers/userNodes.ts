// User-added BIP37 full nodes (SPV), persisted per network.
//
// Kept separate from the Electrum/Fulcrum pool (userServers.ts) because a full
// node speaks the raw BCH P2P protocol, not Electrum — the two are different
// transports and are selected/queried differently. Parsing + validation are
// shared with userServers (host:port + optional label after whitespace); only
// the storage keys and the default port differ.

import { Network } from '../../state/slices/networkSlice';
import { parseServerEntry, isValidServerEntry } from './userServers';

const KEY_PREFIX = 'optn.bip37.nodes.';
const LABEL_KEY_PREFIX = 'optn.bip37.node-labels.';

// Default P2P ports per network (BCHN chainparams). Used when the user enters a
// bare host with no port.
export function defaultNodePort(network: Network): number {
  return network === Network.CHIPNET ? 48333 : 8333;
}

/** Split a node target into host + port, defaulting the port for the network. */
export function parseNodeTarget(target: string, network: Network): { host: string; port: number } {
  const [host, port] = target.split(':');
  return { host, port: port ? Number(port) || defaultNodePort(network) : defaultNodePort(network) };
}

function keyFor(network: Network): string {
  return `${KEY_PREFIX}${network}`;
}
function labelKeyFor(network: Network): string {
  return `${LABEL_KEY_PREFIX}${network}`;
}

function safeList(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
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

export function getNodeLabel(network: Network, target: string): string | undefined {
  return readLabels(network)[target];
}

export function getUserNodes(network: Network): string[] {
  if (typeof localStorage === 'undefined') return [];
  return safeList(localStorage.getItem(keyFor(network)));
}

/** Reuses the Electrum entry validator (host:port shape); label is optional. */
export function isValidNodeEntry(entry: string): boolean {
  return isValidServerEntry(entry);
}

export function addUserNode(network: Network, entry: string): string[] {
  const { target, label } = parseServerEntry(entry);
  const nodes = getUserNodes(network);
  if (target && !nodes.includes(target)) {
    nodes.push(target);
    if (typeof localStorage !== 'undefined') localStorage.setItem(keyFor(network), JSON.stringify(nodes));
  }
  if (target && label) {
    const labels = readLabels(network);
    labels[target] = label;
    writeLabels(network, labels);
  }
  return nodes;
}

export function removeUserNode(network: Network, target: string): string[] {
  const nodes = getUserNodes(network).filter((s) => s !== target);
  if (typeof localStorage !== 'undefined') localStorage.setItem(keyFor(network), JSON.stringify(nodes));
  const labels = readLabels(network);
  if (labels[target]) {
    delete labels[target];
    writeLabels(network, labels);
  }
  return nodes;
}
