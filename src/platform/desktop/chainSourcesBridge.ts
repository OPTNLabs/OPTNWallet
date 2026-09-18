import { invoke } from '@tauri-apps/api/core';

/**
 * The multi-source chain selection, read from and written to the Rust runtime.
 *
 * The runtime owns #75's model: several sources, each with endpoints,
 * capabilities and a disposition, chosen by a connection policy. This module
 * only carries it across the boundary — no selection rule is implemented here,
 * because a second copy of that rule in the renderer is how a policy like
 * "own infrastructure only" ends up quietly enforced in one surface and not
 * another.
 */
export type ChainPolicy =
  | 'auto'
  | 'privacy'
  | 'own_infrastructure'
  | 'electrum_only'
  | 'bip37_only'
  | 'neutrino_only'
  | 'custom';

export type ChainEndpoint = {
  kind: string;
  host: string;
  port: number | null;
};

export type ChainSourceFailure = {
  protocol: string;
  endpoint: ChainEndpoint;
  error: string;
};

export type ChainSource = {
  id: string;
  label: string;
  origin: 'bootstrap' | 'user' | 'own-infrastructure';
  group: string | null;
  disposition: 'enabled' | 'disabled' | 'banned';
  priority: number;
  can_remove: boolean;
  endpoints: ChainEndpoint[];
  capabilities: string[];
  role: 'primary' | 'fallback' | null;
  live_protocols: string[];
  failures: ChainSourceFailure[];
};

export type ChainSourcesView = {
  network: string;
  policy: ChainPolicy;
  protocols: string[];
  scope: string;
  sources: ChainSource[];
  configuration_error: string | null;
  wallet_routes: number;
  verified_tip: { height: number; hash: string } | null;
};

export function readChainSources(network?: string): Promise<ChainSourcesView> {
  return invoke<ChainSourcesView>('optn_chain_sources', {
    network: network ?? null,
  });
}

export function setChainPolicy(
  policy: Exclude<ChainPolicy, 'custom'>,
  network?: string
): Promise<void> {
  return invoke('optn_chain_set_policy', { policy, network: network ?? null });
}

export function setChainSourceDisposition(
  source: string,
  disposition: ChainSource['disposition'],
  network?: string
): Promise<void> {
  return invoke('optn_chain_set_source_disposition', {
    source,
    disposition,
    network: network ?? null,
  });
}

export function addChainSource(request: {
  label: string;
  kind: string;
  host: string;
  port?: number | null;
  infrastructureGroup?: string | null;
  network?: string;
}): Promise<void> {
  return invoke('optn_chain_add_source', {
    request: {
      label: request.label,
      kind: request.kind,
      host: request.host,
      port: request.port ?? null,
      infrastructure_group: request.infrastructureGroup ?? null,
      network: request.network ?? null,
    },
  });
}

export function removeChainSource(
  source: string,
  network?: string
): Promise<void> {
  return invoke('optn_chain_remove_source', {
    source,
    network: network ?? null,
  });
}

/**
 * Rebuild routes now.
 *
 * Routes are rebuilt when the selection changes, and a proxy coming up is not
 * one — so after starting Tor the sources stay refused until something asks.
 */
export function rebuildChainRoutes(): Promise<void> {
  return invoke('optn_chain_rebuild');
}

export const CHAIN_POLICY_LABELS: Record<ChainPolicy, string> = {
  auto: 'Auto',
  privacy: 'Privacy',
  own_infrastructure: 'Own infrastructure only',
  electrum_only: 'Fulcrum/Electrum only',
  bip37_only: 'BIP37 SPV only',
  neutrino_only: 'Neutrino SPV only',
  custom: 'Custom',
};

export const CHAIN_POLICY_DESCRIPTIONS: Record<ChainPolicy, string> = {
  auto: 'Pick a healthy capable source for each operation',
  privacy: 'Client-side filtering only — addresses are not sent to indexed servers',
  own_infrastructure: 'Only sources you marked as your own. Never falls back to public ones',
  electrum_only: 'Electrum protocol servers only',
  bip37_only: 'Bloom-filter SPV peers only',
  neutrino_only: 'Compact-filter SPV peers only',
  custom: 'A policy this list cannot name. Left exactly as saved',
};

/** Offered in the picker. `custom` is a report, never a choice. */
export const SELECTABLE_CHAIN_POLICIES: Exclude<ChainPolicy, 'custom'>[] = [
  'auto',
  'privacy',
  'own_infrastructure',
  'electrum_only',
  'bip37_only',
  'neutrino_only',
];

export const ENDPOINT_KINDS: { value: string; label: string }[] = [
  { value: 'electrum-tls', label: 'Electrum / Fulcrum (TLS)' },
  { value: 'p2p', label: 'BCH peer (BIP37 / Neutrino)' },
  { value: 'node-rpc', label: 'Node RPC' },
  { value: 'node-zmq', label: 'Node ZMQ' },
];

export const DEFAULT_PORTS: Record<string, number> = {
  'electrum-tls': 50002,
  p2p: 8333,
  'node-rpc': 8332,
  'node-zmq': 28332,
};
