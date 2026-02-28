import { store } from '../redux/store';
import { getInfraUrlPools, runWithFailover } from './servers/InfraUrls';

export async function ipfsFetch(uri, options?) {
  if (uri.startsWith('ipfs://')) {
    const net = store.getState().network.currentNetwork;
    const { ipfsGateways } = getInfraUrlPools(net);
    const ipfsPath = uri.slice(7);

    let lastResponse: Response | null = null;
    try {
      return await runWithFailover(
        `ipfs:${net}`,
        ipfsGateways,
        async (gateway) => {
          const resp = await fetch(`${gateway}/${ipfsPath}`, options);
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

  let fetchUri = uri;
  if (!uri.startsWith('https://') && !uri.startsWith('http://')) {
    fetchUri = `https://${fetchUri}`;
  }

  return fetch(fetchUri, options);
}
