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

export type ChainEvidenceConfidence =
  | 'unknown'
  | 'advertised'
  | 'verified'
  | 'rejected';

export type ChainCapabilityDetail = {
  name: string;
  confidence: ChainEvidenceConfidence;
  discovery: string;
};

export type ChainRegisteredCapabilityDetail = {
  endpoint?: ChainEndpoint | null;
  protocol: string;
  name: string;
  confidence: ChainEvidenceConfidence;
  discovery: string;
};

export type ChainProtocolStatus = {
  endpoint: ChainEndpoint;
  protocol: string;
  status: ChainEvidenceConfidence;
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
  /** Rust catalog claims; absent on older hosts. */
  capability_details?: ChainCapabilityDetail[];
  /** Recorded backend claims; absent on older hosts and never route permission. */
  registered_capability_details?: ChainRegisteredCapabilityDetail[];
  /** Per-endpoint status reported by Rust; the renderer never probes here. */
  protocol_statuses?: ChainProtocolStatus[];
  role: 'primary' | 'fallback' | null;
  live_protocols: string[];
  failures: ChainSourceFailure[];
};

export type ChainSelectionProtocol =
  | 'FulcrumElectrum'
  | 'Bip37'
  | 'Neutrino'
  | 'BchnRpc'
  | 'BchnZmq';

/** JSON shape of the existing Rust `WireSourceScope` enum. */
export type ChainSourceScope =
  | 'AllEnabled'
  | 'PublicEnabled'
  | 'MyInfrastructure'
  | { Selected: string[] };

/** JSON shape of the existing Rust `WireConnectionPolicy` contract. */
export type ChainSelection = {
  protocols: ChainSelectionProtocol[];
  primary_scope: ChainSourceScope;
  fallback_scope: ChainSourceScope | null;
  preferred: string[];
};

/**
 * What the host found when it went looking for a proxy.
 *
 * `unverified` is the case worth separating: a SOCKS proxy answered, but every
 * SOCKS proxy answers identically and nothing shows that one is Tor. The
 * holder is the only one who knows, so the screen asks them rather than
 * guessing — and until they say, routes that need Tor refuse.
 */
export type TorProxyView = {
  status: 'verified' | 'unverified' | 'absent' | 'not_needed';
  socks_port: number | null;
  trusted_ports: number[];
};

export type ChainSourcesView = {
  unavailable_services?: { id: string; label: string; reason: string }[];
  network: string;
  policy: ChainPolicy;
  /** Present on hosts exposing the advanced Rust selection contract. */
  selection?: ChainSelection;
  protocols: string[];
  scope: string;
  sources: ChainSource[];
  configuration_error: string | null;
  wallet_routes: number;
  verified_tip: { height: number; hash: string } | null;
  tor: TorProxyView;
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

export function setChainSelection(
  selection: ChainSelection,
  network?: string
): Promise<void> {
  return invoke('optn_chain_set_selection', {
    network: network ?? null,
    selection,
  });
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
  services?: { kind: string; port: number }[];
}): Promise<void> {
  return invoke('optn_chain_add_source', {
    request: {
      label: request.label,
      services: request.services ?? [],
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

/**
 * Confirm, or withdraw confirmation, that a loopback SOCKS port is the
 * holder's own Tor.
 *
 * Probing cannot answer this, so a person does. Loopback only: a SOCKS proxy
 * elsewhere on the network sees the traffic and the address it came from,
 * which is what Tor was being asked to hide.
 */
export function trustSocksProxy(
  port: number,
  trusted: boolean,
  network?: string
): Promise<void> {
  return invoke('optn_chain_trust_socks_proxy', {
    port,
    trusted,
    network: network ?? null,
  });
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
  privacy:
    'Client-side filtering only — addresses are not sent to indexed servers',
  own_infrastructure:
    'Only sources you marked as your own. Never falls back to public ones',
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
  { value: 'ipfs-gateway', label: 'IPFS gateway (HTTPS)' },
];

export const DEFAULT_PORTS: Record<string, number> = {
  'electrum-tls': 50002,
  p2p: 8333,
  'node-rpc': 8332,
  'node-zmq': 28332,
};
