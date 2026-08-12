import { store } from '../redux/store';
import { getInfraUrlPools, runWithFailover } from '../utils/servers/InfraUrls';

export type IpfsUploadResult = {
  name: string;
  cid: string;
  size: number;
  url: string;
  gatewayUrl: string;
};

type UploadResponse = {
  name: string;
  cid: string;
  size: string;
};

type KuboUploadResponse = {
  Name?: string;
  Hash?: string;
  Size?: string;
};

type UploadOptions = {
  filename?: string;
  relayBase?: string;
  gatewayBase?: string;
  timeoutMs?: number;
  maxBytes?: number;
};

type HealthOptions = {
  relayBase?: string;
  gatewayBase?: string;
  timeoutMs?: number;
};

export type IpfsRelayHealthResult = {
  reachable: boolean;
  source: 'relay' | 'gateway' | 'none';
  version?: string;
  endpoint?: string;
  error?: string;
};

type WaitForIpfsAvailabilityOptions = {
  timeoutMs?: number;
  pollIntervalMs?: number;
  validateResponse?: (response: Response) => Promise<void> | void;
};

const DEFAULT_RELAY_BASE = 'https://upload.optnlabs.com';
const DEFAULT_GATEWAY_BASE = 'https://ipfs.optnlabs.com';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_POLL_INTERVAL_MS = 1_000;

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
}

async function readResponseSnippet(response: Response): Promise<string> {
  try {
    const body = (await response.text()).trim();
    return body.slice(0, 240);
  } catch {
    return '';
  }
}

async function fetchJsonWithTimeout(
  url: string,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      method: 'GET',
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function extractVersion(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }
  const candidate = payload as Record<string, unknown>;
  const version = candidate.Version ?? candidate.version;
  return typeof version === 'string' ? version : undefined;
}

function parseUploadResponse(
  payload: unknown,
  gatewayBase: string
): IpfsUploadResult {
  const parsed = payload as Partial<UploadResponse & KuboUploadResponse>;
  const cid = String(parsed.cid ?? parsed.Hash ?? '').trim();
  const name = String(parsed.name ?? parsed.Name ?? '').trim();
  const sizeRaw = parsed.size ?? parsed.Size;
  const size = Number.parseInt(String(sizeRaw ?? ''), 10);

  if (!cid || !name || !Number.isFinite(size) || size < 0) {
    throw new Error('Invalid IPFS relay response payload.');
  }

  const gatewayUrl = buildIpfsGatewayUrl(cid, gatewayBase);
  return {
    name,
    cid,
    size,
    url: gatewayUrl,
    gatewayUrl,
  };
}

export function buildIpfsGatewayUrl(
  cid: string,
  gatewayBase = DEFAULT_GATEWAY_BASE
): string {
  return `${trimTrailingSlash(gatewayBase)}/ipfs/${cid}`;
}

export async function uploadToIpfsRelay(
  file: File | Blob,
  opts?: UploadOptions
): Promise<IpfsUploadResult> {
  const gatewayBase = opts?.gatewayBase ?? DEFAULT_GATEWAY_BASE;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES;

  if (file.size > maxBytes) {
    throw new Error(
      `File is too large (${formatBytes(file.size)}). Max allowed is ${formatBytes(maxBytes)}.`
    );
  }

  const formData = new FormData();
  const hasFileConstructor = typeof File !== 'undefined';
  const inferredName =
    hasFileConstructor && file instanceof File && file.name
      ? file.name
      : opts?.filename ?? 'upload.bin';
  formData.append('file', file, inferredName);

  const relayBases = getUploadRelayBases(opts?.relayBase);

  return runWithFailover(
    `ipfs-upload:${relayBases.join(',')}`,
    relayBases,
    async (relayBase) => {
      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const { uploadUrl, responseParser } = buildUploadEndpoint(relayBase);
        const response = await fetch(uploadUrl, {
          method: 'POST',
          body: formData,
          signal: controller.signal,
        });

        if (!response.ok) {
          const snippet = await readResponseSnippet(response);
          const message = snippet
            ? `IPFS upload failed: HTTP ${response.status} ${response.statusText}. ${snippet}`
            : `IPFS upload failed: HTTP ${response.status} ${response.statusText}.`;
          throw new Error(message);
        }

        const payload = await responseParser(response);
        return parseUploadResponse(payload, gatewayBase);
      } catch (error) {
        if ((error as Error).name === 'AbortError') {
          throw new Error(`IPFS upload timed out after ${timeoutMs}ms.`);
        }
        if (error instanceof TypeError) {
          throw new Error(
            `IPFS upload failed before response (network/CORS). ${error.message}`
          );
        }
        throw error;
      } finally {
        clearTimeout(timeoutHandle);
      }
    }
  );
}

export async function checkIpfsRelayHealth(
  opts?: HealthOptions
): Promise<IpfsRelayHealthResult> {
  const gatewayBase = opts?.gatewayBase ?? DEFAULT_GATEWAY_BASE;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const relayBases = getUploadRelayBases(opts?.relayBase);

  for (const relayBase of relayBases) {
    const relayEndpoint = buildVersionEndpoint(relayBase);
    try {
      const relayResp = await fetchJsonWithTimeout(relayEndpoint, timeoutMs);
      if (relayResp.ok) {
        const relayPayload = (await relayResp.json()) as unknown;
        return {
          reachable: true,
          source: 'relay',
          version: extractVersion(relayPayload),
          endpoint: relayEndpoint,
        };
      }
    } catch {
      // Try next relay, then fall back to gateway checks.
    }
  }

  const gatewayEndpoint = `${trimTrailingSlash(gatewayBase)}/api/v0/version`;
  try {
    const gatewayResp = await fetchJsonWithTimeout(gatewayEndpoint, timeoutMs);
    if (gatewayResp.ok) {
      const gatewayPayload = (await gatewayResp.json()) as unknown;
      return {
        reachable: true,
        source: 'gateway',
        version: extractVersion(gatewayPayload),
        endpoint: gatewayEndpoint,
      };
    }

    const snippet = await readResponseSnippet(gatewayResp);
    return {
      reachable: false,
      source: 'none',
      endpoint: gatewayEndpoint,
      error: snippet
        ? `HTTP ${gatewayResp.status} ${gatewayResp.statusText}. ${snippet}`
        : `HTTP ${gatewayResp.status} ${gatewayResp.statusText}.`,
    };
  } catch (error) {
    return {
      reachable: false,
      source: 'none',
      endpoint: gatewayEndpoint,
      error: error instanceof Error ? error.message : 'Health check failed.',
    };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function waitForIpfsAvailability(
  uri: string,
  opts?: WaitForIpfsAvailabilityOptions
): Promise<void> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = opts?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  let lastError = 'No response received yet.';

  while (Date.now() < deadline) {
    try {
      const response = await fetchIpfsAvailability(uri);
      if (!response.ok) {
        lastError = `HTTP ${response.status} ${response.statusText}`;
      } else {
        await opts?.validateResponse?.(response);
        return;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    if (Date.now() >= deadline) break;
    await delay(pollIntervalMs);
  }

  throw new Error(
    `IPFS content was not reachable in time for ${uri}. ${lastError}`
  );
}

function getUploadRelayBases(explicitRelayBase?: string): string[] {
  if (explicitRelayBase) {
    return [trimTrailingSlash(explicitRelayBase)];
  }

  try {
    const net = store.getState().network.currentNetwork;
    const configured = getInfraUrlPools(net).ipfsUploadRelayBases;
    if (configured.length > 0) return configured.map(trimTrailingSlash);
  } catch {
    // fall through to defaults
  }

  return [DEFAULT_RELAY_BASE, 'https://ipfs-api.optnlabs.com'].map(
    trimTrailingSlash
  );
}

function buildUploadEndpoint(relayBase: string): {
  uploadUrl: string;
  responseParser: (response: Response) => Promise<unknown>;
} {
  const base = trimTrailingSlash(relayBase);
  if (base.includes('ipfs-api.optnlabs.com')) {
    return {
      uploadUrl: `${base}/api/v0/add?pin=true`,
      responseParser: async (response) => response.json(),
    };
  }

  return {
    uploadUrl: `${base}/v1/ipfs/add`,
    responseParser: async (response) => response.json(),
  };
}

function buildVersionEndpoint(relayBase: string): string {
  const base = trimTrailingSlash(relayBase);
  if (base.includes('ipfs-api.optnlabs.com')) {
    return `${base}/api/v0/version`;
  }
  return `${base}/v1/ipfs/version`;
}

async function fetchIpfsAvailability(uri: string): Promise<Response> {
  if (uri.startsWith('https://') || uri.startsWith('http://')) {
    return fetch(uri);
  }
  const { ipfsFetch } = await import('../utils/ipfs');
  return ipfsFetch(uri);
}
