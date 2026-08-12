import { Network } from '../../redux/networkSlice';

function env(name: string): string | undefined {
  const metaEnv =
    typeof import.meta !== 'undefined'
      ? ((import.meta as ImportMeta & { env?: Record<string, unknown> }).env ??
        {})
      : {};
  const nodeEnv =
    typeof process !== 'undefined'
      ? ((process as { env?: Record<string, unknown> }).env ?? {})
      : {};

  const viteValue = metaEnv[name];
  const nodeValue = nodeEnv[name];
  if (typeof viteValue === 'string') return viteValue;
  if (typeof nodeValue === 'string') return nodeValue;
  return undefined;
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

export function getCauldronAppBaseUrl(network: Network): string {
  const override =
    network === Network.CHIPNET
      ? env('VITE_CAULDRON_CHIPNET_BASE_URL') || env('CAULDRON_CHIPNET_BASE_URL')
      : env('VITE_CAULDRON_MAINNET_BASE_URL') || env('CAULDRON_MAINNET_BASE_URL');

  if (override) return normalizeBaseUrl(override);

  return normalizeBaseUrl('https://app.cauldron.quest');
}

export function getCauldronApiBaseUrl(network: Network): string {
  const override =
    network === Network.CHIPNET
      ? env('VITE_CAULDRON_CHIPNET_API_BASE_URL') ||
        env('CAULDRON_CHIPNET_API_BASE_URL')
      : env('VITE_CAULDRON_MAINNET_API_BASE_URL') ||
        env('CAULDRON_MAINNET_API_BASE_URL');

  if (override) return normalizeBaseUrl(override);

  return normalizeBaseUrl(
    network === Network.CHIPNET
      ? 'https://indexer-chipnet.riften.net/cauldron'
      : 'https://indexer.riften.net/cauldron'
  );
}

function normalizeServerList(raw: string): string[] {
  return raw
    .split(/[\n,\s]+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

export function getCauldronRostrumServers(network: Network): string[] {
  const networkSpecific =
    network === Network.CHIPNET
      ? env('VITE_CAULDRON_CHIPNET_ROSTRUM_SERVERS') ||
        env('CAULDRON_CHIPNET_ROSTRUM_SERVERS')
      : env('VITE_CAULDRON_MAINNET_ROSTRUM_SERVERS') ||
        env('CAULDRON_MAINNET_ROSTRUM_SERVERS');
  const shared =
    env('VITE_CAULDRON_ROSTRUM_SERVERS') || env('CAULDRON_ROSTRUM_SERVERS');

  const configured = normalizeServerList(networkSpecific || shared || '');
  if (configured.length > 0) {
    return configured;
  }

  // Selene currently points both networks at the same Cauldron Rostrum host.
  return ['rostrum.cauldron.quest:50004'];
}
