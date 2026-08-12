// src/utils/servers/InfraUrls.ts

import { Network } from '../../redux/networkSlice';

// Central place for all infra endpoints.
// Keep these as *base* URLs/hosts (no trailing slashes unless needed).

export type InfraUrls = {
  chaingraphUrl: string; // full URL
  bcmrApiBaseUrl: string; // base URL for BCMR API (no trailing slash)
};

export const INFRA_URLS: Record<Network, InfraUrls> = {
  [Network.CHIPNET]: {
    chaingraphUrl: 'https://chaingraph.optnlabs.com/v1/graphql',
    bcmrApiBaseUrl: 'https://bcmr.optnlabs.com/api',
  },

  // MAINNET: keeping existing public infra defaults for now.
  // Swap these later when OPTN mainnet endpoints are live.
  [Network.MAINNET]: {
    chaingraphUrl: 'https://gql.chaingraph.pat.mn/v1/graphql',
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
 * - VITE_CHAINGRAPH_URL
 * - VITE_BCMR_API_BASE_URL
 *
 * (global overrides regardless of network)
 */
export function getInfraUrls(network: Network): InfraUrls {
  const base = INFRA_URLS[network];

  const chaingraphUrl = readEnv('VITE_CHAINGRAPH_URL') || base.chaingraphUrl;
  const bcmrApiBaseUrl =
    readEnv('VITE_BCMR_API_BASE_URL') || base.bcmrApiBaseUrl;

  return {
    chaingraphUrl,
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
