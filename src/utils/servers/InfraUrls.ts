// src/utils/servers/InfraUrls.ts

import { Network } from '../../state/slices/networkSlice';

export type InfraUrls = {
  chaingraphUrl: string; // full URL
  bcmrApiBaseUrl: string; // base URL for BCMR API (no trailing slash)
};

export type InfraUrlPools = {
  electrumServers: string[];
  chaingraphUrls: string[];
  bcmrNativeBaseUrls: string[];
  bcmrApiBaseUrls: string[];
  ipfsGateways: string[];
  ipfsUploadRelayBases: string[];
};

const DEFAULT_INFRA_URL_POOLS: Record<Network, InfraUrlPools> = {
  [Network.CHIPNET]: {
    // Seeded from Electron Cash's server list, but only the entries that were
    // actually verified to accept a WebSocket (WSS) connection on port 50004 —
    // this app connects over WSS, and most Fulcrum servers publish only a raw
    // TCP-SSL port (50002) with no WSS listener, so seeding those unverified
    // would just add dead endpoints to the failover pool. OPTN's own server is
    // kept first (first-party infra) even though an external probe couldn't
    // reach it (likely geo/temporary).
    electrumServers: [
      'electrum-chipnet.optnlabs.com',
      'chipnet.imaginary.cash',
      'chipnet.bch.ninja',
      'blackie.c3-soft.com',
    ],
    chaingraphUrls: ['https://gql.chaingraph.pat.mn/v1/graphql'],
    bcmrNativeBaseUrls: ['https://tokenindex.optnlabs.com/v1'],
    bcmrApiBaseUrls: [
      'https://bcmr.optnlabs.com/api',
      'https://bcmr-chipnet.paytaca.com/api',
    ],
    ipfsGateways: [
      'https://ipfs.optnlabs.com/ipfs',
      'https://ipfs.io/ipfs',
      'https://dweb.link/ipfs',
    ],
    ipfsUploadRelayBases: [
      'https://upload.optnlabs.com',
      'https://ipfs-api.optnlabs.com',
    ],
  },

  [Network.MAINNET]: {
    // Seeded from Electron Cash's server list, filtered to only those verified
    // to accept a WebSocket (WSS) connection on port 50004 — see the CHIPNET
    // note above. Dropped the previous 'explorer.bch.ninja' default: it fails
    // WSS with a certificate-hostname mismatch. Order is roughly most-reliable
    // first; the failover logic skips any that are down at runtime anyway.
    electrumServers: [
      'electrum.imaginary.cash',
      'bch.imaginary.cash',
      'cashnode.bch.ninja',
      'bch.loping.net',
      'bch.soul-dev.com',
      'blackie.c3-soft.com',
      'electroncash.dk',
      'fulcrum.criptolayer.net',
      'fulcrum.jettscythe.xyz',
    ],
    chaingraphUrls: ['https://gql.chaingraph.pat.mn/v1/graphql'],
    bcmrNativeBaseUrls: ['https://tokenindex.optnlabs.com/v1'],
    bcmrApiBaseUrls: ['https://bcmr.optnlabs.com/api', 'https://bcmr.paytaca.com/api'],
    ipfsGateways: [
      'https://ipfs.optnlabs.com/ipfs',
      'https://ipfs.io/ipfs',
      'https://dweb.link/ipfs',
    ],
    ipfsUploadRelayBases: [
      'https://upload.optnlabs.com',
      'https://ipfs-api.optnlabs.com',
    ],
  },
};

function readEnv(key: string): string | undefined {
  try {
    type ImportMetaWithEnv = ImportMeta & {
      env?: Record<string, string | undefined>;
    };
    const env = (import.meta as ImportMetaWithEnv).env;
    // Vite env
    if (typeof import.meta !== 'undefined' && env?.[key]) {
      return String(env[key]);
    }
  } catch {
    // ignore
  }
  return undefined;
}

function parseEnvList(raw?: string): string[] {
  if (!raw) return [];
  return raw
    .split(/[\n,\s]+/)
    .map((v) => v.trim())
    .filter(Boolean);
}

function dedupe(items: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function networkSuffix(network: Network): 'MAINNET' | 'CHIPNET' {
  return network === Network.MAINNET ? 'MAINNET' : 'CHIPNET';
}

function readEndpointList(
  network: Network,
  listKey: string,
  legacySingleKey?: string
): string[] {
  const suffix = networkSuffix(network);
  const listRaw =
    readEnv(`${listKey}_${suffix}`) ||
    readEnv(listKey) ||
    (legacySingleKey
      ? readEnv(`${legacySingleKey}_${suffix}`) || readEnv(legacySingleKey)
      : undefined);
  return dedupe(parseEnvList(listRaw));
}

function normalizeHttpUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return trimmed;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function normalizeBcmrApiBaseUrl(url: string): string {
  return normalizeHttpUrl(url).replace(/\/+$/, '');
}

function normalizeBcmrNativeBaseUrl(url: string): string {
  return normalizeHttpUrl(url).replace(/\/+$/, '');
}

function normalizeIpfsGateway(url: string): string {
  const normalized = normalizeHttpUrl(url).replace(/\/+$/, '');
  return normalized.endsWith('/ipfs') ? normalized : `${normalized}/ipfs`;
}

function normalizeIpfsUploadRelay(url: string): string {
  return normalizeHttpUrl(url).replace(/\/+$/, '');
}

/**
 * One centralized endpoint source for all wallet infra connections.
 * Supports network-specific env overrides with CSV values.
 */
export function getInfraUrlPools(network: Network): InfraUrlPools {
  const defaults = DEFAULT_INFRA_URL_POOLS[network];

  const electrumServers =
    readEndpointList(network, 'VITE_ELECTRUM_SERVERS').map((x) => x.trim()) ||
    [];
  const chaingraphUrls = readEndpointList(
    network,
    'VITE_CHAINGRAPH_URLS',
    'VITE_CHAINGRAPH_URL'
  ).map(normalizeHttpUrl);
  const bcmrNativeBaseUrls = readEndpointList(
    network,
    'VITE_BCMR_NATIVE_BASE_URLS',
    'VITE_BCMR_NATIVE_BASE_URL'
  ).map(normalizeBcmrNativeBaseUrl);
  const bcmrApiBaseUrls = readEndpointList(
    network,
    'VITE_BCMR_API_BASE_URLS',
    'VITE_BCMR_API_BASE_URL'
  ).map(normalizeBcmrApiBaseUrl);
  const ipfsGateways = readEndpointList(network, 'VITE_IPFS_GATEWAYS').map(
    normalizeIpfsGateway
  );
  const ipfsUploadRelayBases = readEndpointList(
    network,
    'VITE_IPFS_UPLOAD_RELAYS'
  ).map(normalizeIpfsUploadRelay);

  return {
    electrumServers:
      electrumServers.length > 0 ? electrumServers : defaults.electrumServers,
    chaingraphUrls:
      chaingraphUrls.length > 0 ? chaingraphUrls : defaults.chaingraphUrls,
    bcmrNativeBaseUrls:
      bcmrNativeBaseUrls.length > 0
        ? bcmrNativeBaseUrls
        : defaults.bcmrNativeBaseUrls.map(normalizeBcmrNativeBaseUrl),
    bcmrApiBaseUrls:
      bcmrApiBaseUrls.length > 0
        ? bcmrApiBaseUrls
        : defaults.bcmrApiBaseUrls.map(normalizeBcmrApiBaseUrl),
    ipfsGateways:
      ipfsGateways.length > 0
        ? ipfsGateways
        : defaults.ipfsGateways.map(normalizeIpfsGateway),
    ipfsUploadRelayBases:
      ipfsUploadRelayBases.length > 0
        ? ipfsUploadRelayBases
        : defaults.ipfsUploadRelayBases.map(normalizeIpfsUploadRelay),
  };
}

/**
 * Lightweight failover helper:
 * - Tries endpoints in deterministic order
 * - Remembers the last healthy endpoint per pool key
 */
const lastHealthyIndex = new Map<string, number>();

function rotateFromIndex<T>(arr: T[], start: number): T[] {
  if (!arr.length) return arr;
  const idx = ((start % arr.length) + arr.length) % arr.length;
  return [...arr.slice(idx), ...arr.slice(0, idx)];
}

export async function runWithFailover<T>(
  poolKey: string,
  endpoints: string[],
  runner: (endpoint: string) => Promise<T>
): Promise<T> {
  if (!endpoints.length) {
    throw new Error(`No endpoints configured for ${poolKey}`);
  }

  const startIdx = lastHealthyIndex.get(poolKey) ?? 0;
  const ordered = rotateFromIndex(endpoints, startIdx);
  const errors: string[] = [];

  for (const endpoint of ordered) {
    try {
      const result = await runner(endpoint);
      const idx = endpoints.indexOf(endpoint);
      if (idx >= 0) lastHealthyIndex.set(poolKey, idx);
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${endpoint} -> ${msg}`);
    }
  }

  throw new Error(`All ${poolKey} endpoints failed: ${errors.join(' | ')}`);
}

/**
 * Allow env overrides:
 * - VITE_CHAINGRAPH_URL(S)
 * - VITE_BCMR_API_BASE_URL(S)
 */
export function getInfraUrls(network: Network): InfraUrls {
  const pools = getInfraUrlPools(network);
  const chaingraphUrl = pools.chaingraphUrls[0];
  const bcmrApiBaseUrl = pools.bcmrApiBaseUrls[0];

  return {
    chaingraphUrl,
    bcmrApiBaseUrl,
  };
}

/**
 * Legacy BCMR-compatible route shape used for bcmr-indexer fallback:
 *   /api/registries/:authbase/latest
 */
export function getBcmrLatestRegistryUrl(
  network: Network,
  authbase: string
): string {
  return getBcmrLatestRegistryUrls(network, authbase)[0];
}

export function getBcmrLatestRegistryUrls(
  network: Network,
  authbase: string
): string[] {
  const { bcmrApiBaseUrls } = getInfraUrlPools(network);
  return bcmrApiBaseUrls.map((base) => `${base}/registries/${authbase}/latest`);
}

export function getBcmrNativeTokenUrls(
  network: Network,
  category: string
): string[] {
  const { bcmrNativeBaseUrls } = getInfraUrlPools(network);
  return bcmrNativeBaseUrls.map((base) => `${base}/token/${category}/bcmr`);
}

// Servers that only expose the raw Electrum TCP-SSL port (50002) and have NO
// WebSocket listener — verified by probing. Unreachable from the web/WSS build,
// but the desktop build talks to them natively over TCP-SSL, so they are added
// to the pool only there.
const DESKTOP_ONLY_TCP_SERVERS: Record<Network, string[]> = {
  [Network.MAINNET]: [
    'bch0.kister.net',
    'electron.jochen-hoenicke.de',
    'electrs.bitcoinunlimited.info',
    'bch.cyberbits.eu',
    'fulcrum.aglauck.com',
  ],
  [Network.CHIPNET]: [],
};

function isDesktop(): boolean {
  // Tauri injects this global into the webview; it is absent in a plain browser
  // (and in the mobile Capacitor WebView), so it cleanly identifies the desktop
  // build without needing a build-time flag.
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export function getElectrumServers(network: Network): string[] {
  const base = getInfraUrlPools(network).electrumServers;
  if (isDesktop()) {
    return dedupe([...base, ...DESKTOP_ONLY_TCP_SERVERS[network]]);
  }
  return base;
}
