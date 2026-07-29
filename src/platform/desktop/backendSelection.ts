// Which backend the wallet talks to — exactly ONE at a time.
//
//   auto        : use the server pool with failover (current default behavior)
//   server:HOST : pin a specific Electrum/Fulcrum server
//   node:HOST   : pin a specific BIP37 full node (trustless, direct P2P)
//
// The point is exclusivity: with a node pinned, wallet data comes from the node
// (verified by merkle proofs) and Electrum is not consulted — and vice versa.
// Persisted per network in localStorage so it survives reloads, and readable
// synchronously by the transport layer (no store dependency).

import { Network } from '../../state/slices/networkSlice';

export type Backend =
  | { kind: 'auto' }
  | { kind: 'server'; target: string }
  | { kind: 'node'; target: string };

const KEY_PREFIX = 'optn.backend.selection.';

const keyFor = (network: Network) => `${KEY_PREFIX}${network}`;

export function getBackend(network: Network): Backend {
  if (typeof localStorage === 'undefined') return { kind: 'auto' };
  try {
    const raw = localStorage.getItem(keyFor(network));
    if (!raw) return { kind: 'auto' };
    const parsed = JSON.parse(raw) as Backend;
    if (parsed?.kind === 'node' || parsed?.kind === 'server') {
      return typeof parsed.target === 'string' && parsed.target ? parsed : { kind: 'auto' };
    }
    return { kind: 'auto' };
  } catch {
    return { kind: 'auto' };
  }
}

export function setBackend(network: Network, backend: Backend): void {
  if (typeof localStorage === 'undefined') return;
  if (backend.kind === 'auto') localStorage.removeItem(keyFor(network));
  else localStorage.setItem(keyFor(network), JSON.stringify(backend));
  // Let the UI + transport react immediately (same-tab storage events don't fire).
  window.dispatchEvent(new CustomEvent(BACKEND_CHANGED_EVENT, { detail: { network, backend } }));
}

export const BACKEND_CHANGED_EVENT = 'optn:backend-changed';

/** True when a BIP37 node is pinned as the wallet's backend for this network. */
export function activeNode(network: Network): string | null {
  const b = getBackend(network);
  return b.kind === 'node' ? b.target : null;
}
