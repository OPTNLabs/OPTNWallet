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

const DEFAULT_RELAY_BASE = 'https://upload.optnlabs.com';
const DEFAULT_GATEWAY_BASE = 'https://ipfs.optnlabs.com';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

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
  const parsed = payload as Partial<UploadResponse>;
  const cid = (parsed.cid ?? '').trim();
  const name = (parsed.name ?? '').trim();
  const sizeRaw = parsed.size;
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
  const relayBase = opts?.relayBase ?? DEFAULT_RELAY_BASE;
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

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  const uploadUrl = `${trimTrailingSlash(relayBase)}/v1/ipfs/add`;
  try {
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

    const payload = (await response.json()) as unknown;
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

export async function checkIpfsRelayHealth(
  opts?: HealthOptions
): Promise<IpfsRelayHealthResult> {
  const relayBase = opts?.relayBase ?? DEFAULT_RELAY_BASE;
  const gatewayBase = opts?.gatewayBase ?? DEFAULT_GATEWAY_BASE;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const relayEndpoint = `${trimTrailingSlash(relayBase)}/v1/ipfs/version`;
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
    // Fall back to public gateway endpoint check.
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
