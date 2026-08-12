import { store } from '../redux/store';
import { getInfraUrlPools, runWithFailover } from './servers/InfraUrls';

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

async function fetchFromGateways(ipfsPath: string, options?: RequestInit) {
  const net = store.getState().network.currentNetwork;
  const { ipfsGateways } = getInfraUrlPools(net);
  let lastResponse: Response | null = null;

  try {
    return await runWithFailover(
      `ipfs:${net}`,
      ipfsGateways,
      async (gateway) => {
        const resp = await fetch(
          `${gateway}/${normalizeIpfsPath(ipfsPath)}`,
          options
        );
        if (!resp.ok) {
          lastResponse = resp;
          throw new Error(`HTTP ${resp.status}`);
        }
        return resp;
      }
    );
  } catch (err) {
    if (lastResponse) return lastResponse;
    throw err;
  }
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
