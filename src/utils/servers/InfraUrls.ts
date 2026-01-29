// src/utils/servers/InfraUrls.ts

import { Network } from '../../redux/networkSlice';

// Central place for all infra endpoints.
// Keep these as *base* URLs/hosts (no trailing slashes unless needed).

export type InfraUrls = {
  electrumHost: string; // host only (no scheme)
  chaingraphGraphqlUrl: string; // full URL
  bcmrApiBaseUrl: string; // base URL for BCMR API (no trailing slash)
};

export const INFRA_URLS: Record<Network, InfraUrls> = {
  [Network.CHIPNET]: {
    electrumHost: 'electrum-chipnet.optnlabs.com',
    chaingraphGraphqlUrl: 'https://chaingraph.optnlabs.com/v1/graphql',
    bcmrApiBaseUrl: 'http://bcmr.optnlabs.com/api',
  },

  // MAINNET: keeping existing public infra defaults for now.
  // Swap these later when OPTN mainnet endpoints are live.
  [Network.MAINNET]: {
    electrumHost: 'explorer.bch.ninja',
    chaingraphGraphqlUrl: 'https://chaingraph.optnlabs.com/v1/graphql', // fallback
    bcmrApiBaseUrl: 'https://bcmr.paytaca.com/api',
  },
};

function readEnv(key: string): string | undefined {
  try {
    // Vite env
    if (
      typeof import.meta !== 'undefined' &&
      (import.meta as any)?.env?.[key]
    ) {
      return String((import.meta as any).env[key]);
    }
  } catch {
    // ignore
  }
  return undefined;
}

/**
 * Allow env overrides:
 * - VITE_ELECTRUM_HOST
 * - VITE_CHAINGRAPH_URL
 * - VITE_BCMR_API_BASE_URL
 *
 * (global overrides regardless of network)
 */
export function getInfraUrls(network: Network): InfraUrls {
  const base = INFRA_URLS[network];

  const electrumHost = readEnv('VITE_ELECTRUM_HOST') || base.electrumHost;
  const chaingraphGraphqlUrl =
    readEnv('VITE_CHAINGRAPH_URL') || base.chaingraphGraphqlUrl;
  const bcmrApiBaseUrl =
    readEnv('VITE_BCMR_API_BASE_URL') || base.bcmrApiBaseUrl;

  return {
    electrumHost,
    chaingraphGraphqlUrl,
    bcmrApiBaseUrl: bcmrApiBaseUrl.replace(/\/+$/, ''), // trim trailing /
  };
}

/**
 * Paytaca-compatible route shape used by your code:
 *   /api/registries/:authbase/latest
 */
export function getBcmrLatestRegistryUrl(
  network: Network,
  authbase: string
): string {
  const { bcmrApiBaseUrl } = getInfraUrls(network);
  return `${bcmrApiBaseUrl}/registries/${authbase}/latest`;
}
