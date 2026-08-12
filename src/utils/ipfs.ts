import { store } from '../redux/store';
import { getInfraUrlPools, runWithFailover } from './servers/InfraUrls';

const IPFS_GATEWAY_TIMEOUT_MS = 8000;
const inflightGatewayRequests = new Map<string, Promise<Response>>();

function normalizeIpfsPath(path: string): string {
  return path.replace(/^\/+/, '').replace(/^ipfs\//i, '');
}

function extractIpfsPath(uri: string): string | null {
  if (!uri) return null;
  if (uri.startsWith('ipfs://')) {
    return normalizeIpfsPath(uri.slice(7));
  }

  try {
    const url = new URL(uri);
    const hostParts = url.hostname.split('.');
    const pathNoSlash = url.pathname.replace(/^\/+/, '');
    const search = url.search || '';

    // Common gateway form: https://gateway.tld/ipfs/<cid>/...
    const marker = '/ipfs/';
    const idx = url.pathname.indexOf(marker);
    if (idx >= 0) {
      return normalizeIpfsPath(url.pathname.slice(idx + marker.length) + search);
    }

    // Subdomain gateway form: https://<cid>.ipfs.gateway.tld/...
    const ipfsLabelIndex = hostParts.indexOf('ipfs');
    if (ipfsLabelIndex > 0) {
      const cid = hostParts[ipfsLabelIndex - 1];
      return normalizeIpfsPath(`${cid}/${pathNoSlash}${search}`);
    }
  } catch {
    // not a valid URL
  }

  return null;
}

export function resolveIpfsGatewayUrl(uri: string): string | null {
  const ipfsPath = extractIpfsPath(uri);
  if (!ipfsPath) return null;

  const net = store.getState().network.currentNetwork;
  const { ipfsGateways } = getInfraUrlPools(net);
  const gateway = ipfsGateways[0];
  if (!gateway) return null;

  return `${gateway}/${normalizeIpfsPath(ipfsPath)}`;
}

async function fetchFromGateways(ipfsPath: string, options?: RequestInit) {
  const net = store.getState().network.currentNetwork;
  const { ipfsGateways } = getInfraUrlPools(net);
  let lastResponse: Response | null = null;
  const normalizedPath = normalizeIpfsPath(ipfsPath);
  const requestKey = `${net}:${normalizedPath}`;

  const inflight = inflightGatewayRequests.get(requestKey);
  if (inflight) {
    const response = await inflight;
    return typeof response.clone === 'function' ? response.clone() : response;
  }

  const requestPromise = (async () => {
    try {
      return await runWithFailover(
        `ipfs:${net}`,
        ipfsGateways,
        async (gateway) => {
          const controller = new AbortController();
          const signal = mergeAbortSignals(options?.signal, controller.signal);
          const timeoutId = globalThis.setTimeout(() => {
            controller.abort(new Error(`Timeout after ${IPFS_GATEWAY_TIMEOUT_MS}ms`));
          }, IPFS_GATEWAY_TIMEOUT_MS);

          try {
            const resp = await fetch(`${gateway}/${normalizedPath}`, {
              ...options,
              signal,
            });
            if (!resp.ok) {
              lastResponse = resp;
              throw new Error(`HTTP ${resp.status}`);
            }
            return resp;
          } finally {
            globalThis.clearTimeout(timeoutId);
          }
        }
      );
    } catch (err) {
      if (lastResponse) return lastResponse;
      throw err;
    } finally {
      inflightGatewayRequests.delete(requestKey);
    }
  })();

  inflightGatewayRequests.set(requestKey, requestPromise);
  const response = await requestPromise;
  return typeof response.clone === 'function' ? response.clone() : response;
}

export async function ipfsFetch(uri, options?) {
  const ipfsPath = extractIpfsPath(uri);
  if (ipfsPath) {
    return fetchFromGateways(ipfsPath, options);
  }

  let fetchUri = uri;
  if (!uri.startsWith('https://') && !uri.startsWith('http://')) {
    fetchUri = `https://${fetchUri}`;
  }

  try {
    return await fetch(fetchUri, options);
  } catch (err) {
    // Browser CORS/network failures can happen on third-party IPFS URLs.
    const fallbackIpfsPath = extractIpfsPath(fetchUri);
    if (!fallbackIpfsPath) throw err;
    return fetchFromGateways(fallbackIpfsPath, options);
  }
}

function mergeAbortSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const activeSignals = signals.filter(Boolean) as AbortSignal[];
  if (activeSignals.length === 0) return undefined;
  if (activeSignals.length === 1) return activeSignals[0];

  const controller = new AbortController();
  const abort = (event?: Event) => {
    const source = event?.target as AbortSignal | null;
    controller.abort(source?.reason);
  };

  activeSignals.forEach((signal) => {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
  });

  return controller.signal;
}
