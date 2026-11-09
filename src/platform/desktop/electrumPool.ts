// The Electrum servers this wallet may use, from Rust.
//
// The holder's source selection (Settings → Servers) decides which servers
// the wallet talks to. Rust refuses to dial anything else
// (`electrum_tcp_connect` answers `electrum-not-selected`), so the renderer
// takes its server list from the same rule (`optn_chain_electrum_pool`)
// instead of its own defaults. A disabled or banned server, or a policy
// without Electrum (Privacy, own infrastructure only, BIP37 or Neutrino only),
// then takes effect here at once.
//
// Shared code reads the list through a global hook (see InfraUrls
// getElectrumServers), so it never imports desktop modules.

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export const NOT_SELECTED = 'electrum-not-selected';

type SelectedElectrum = { host: string; port: number; tls: boolean };
export type ElectrumPool = {
  allowed: boolean;
  reason: string | null;
  servers: SelectedElectrum[];
};

const pending = new Map<string, Promise<ElectrumPool>>();
const resolved = new Map<string, ElectrumPool>();

/** Fetch the pool for `network`, once until Rust says it changed. */
export function electrumPool(network: string): Promise<ElectrumPool> {
  const known = pending.get(network);
  if (known) return known;
  const fetching = invoke<ElectrumPool>('optn_chain_electrum_pool', {
    network,
  }).then(
    (pool) => {
      if (pending.get(network) === fetching) resolved.set(network, pool);
      return pool;
    },
    (error: unknown) => {
      // Asked again next time: an unreadable settings file must not be
      // remembered as an answer.
      if (pending.get(network) === fetching) pending.delete(network);
      throw error;
    }
  );
  pending.set(network, fetching);
  return fetching;
}

/** An error that says the selection, not the server, refused. */
export function notSelectedError(reason: string): Error {
  return new Error(`${NOT_SELECTED}: ${reason}`);
}

export function isNotSelected(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith(NOT_SELECTED);
}

/**
 * The pool as the shared Electrum client's server entries: `host:port`,
 * always TLS. Plain-TCP servers and IPv6 literals cannot be written in that
 * form and are left out; Rust would refuse anything else anyway.
 */
export function poolEntries(pool: ElectrumPool): string[] {
  return pool.servers
    .filter((server) => server.tls && !server.host.includes(':'))
    .map((server) => `${server.host}:${server.port}`);
}

function cachedEntries(network: string): string[] | null {
  const pool = resolved.get(network);
  if (!pool) {
    // Start fetching for the next caller; this one gets the shared defaults,
    // which Rust still checks one by one.
    void electrumPool(network).catch(() => undefined);
    return null;
  }
  return poolEntries(pool);
}

(globalThis as Record<string, unknown>).__OPTN_ELECTRUM_POOL__ = cachedEntries;

void listen<string>('optn://electrum-pool-changed', (event) => {
  pending.delete(event.payload);
  resolved.delete(event.payload);
}).catch(() => undefined);
