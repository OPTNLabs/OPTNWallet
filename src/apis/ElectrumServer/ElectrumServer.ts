// src/apis/ElectrumServer/ElectrumServer.ts

import {
  ElectrumClient,
  RequestResponse,
  ElectrumClientEvents,
} from '@electrum-cash/network';
import { ElectrumWebSocket } from '@electrum-cash/web-socket';
import {
  getElectrumServers,
} from '../../utils/servers/ElectrumServers';
import {
  getPreferredStorage,
  readStorageItem,
  writeStorageItem,
} from '../../utils/browserStorage';
import { store } from '../../state/store';
import { selectCurrentNetwork } from '../../state/selectors/networkSelectors';
import { Network } from '../../state/slices/networkSlice';
import {
  getAllServerHealth,
  rankServersForConnect,
  recordServerFailure,
  recordServerSuccess,
} from '../../services/electrum/fulcrumReliability';

// ---------- Config ----------
// Keep connect attempts short: walking a long server list at 8s each made cold
// sync look stuck for ~1 minute before the first UTXO batch ran.
const CONNECT_TIMEOUT_MS = 4000;
const REQUEST_TIMEOUT_MS = 12000;
/**
 * requestMany(N) used a flat 12s budget for the whole batch. A 250-call
 * listunspent batch on chipnet regularly hit:
 *   `requestMany(250) timed out after 12000ms`
 * Scale with N, cap so a dead server still fails over.
 */
const REQUEST_MANY_PER_CALL_MS = 80;
const REQUEST_MANY_TIMEOUT_CAP_MS = 90_000;
/** Cap how many hosts we try in one connect round before failing over later. */
const MAX_CONNECT_HOSTS_PER_ROUND = 3;
const BACKOFF_BASE_MS = 3000;
const BACKOFF_MAX_MS = 60000;
const WSS_PORT = 50004;
const IDLE_RECONNECT_AFTER_MS = 5 * 60 * 1000;
const SERVER_FAILURE_COOLDOWN_MS = 15 * 60 * 1000;
const LAST_HEALTHY_SERVER_STORAGE_KEY = 'optn.electrum.last-healthy-server';

// Convenience alias for a typed Electrum client
type ECClient = ElectrumClient<ElectrumClientEvents>;
type ElectrumParams = RequestResponse[];
type BatchRequest = {
  method: string;
  params?: ElectrumParams;
};

// ---------- Internal state ----------
let electrum: ECClient | null = null;
let connectPromise: Promise<ECClient> | null = null;
let serverIndex = 0;
let backoffMs = BACKOFF_BASE_MS;
let nextAllowedConnectTs = 0;
let lastSuccessfulActivityTs = 0;
let currentServer: string | null = null;

// Make sure we only wire 'notification' once per client instance
let notificationsWired = false;

// Fan-out of notification listeners (UI, services, etc.)
type Notification = { jsonrpc: '2.0'; method: string; params: ElectrumParams };
type NotificationHandler = (n: Notification) => void;
const notificationHandlers = new Set<NotificationHandler>();

// Registry of active subscriptions for resubscribe-on-reconnect
// We key by method + JSON.stringify(params)
type SubEntry = { method: string; params?: ElectrumParams };
const activeSubs = new Map<string, SubEntry>();
const blockedServers = new Map<string, number>();

function getNetworkAndServers(): { network: Network; servers: string[] } {
  const state = store.getState();
  const network = selectCurrentNetwork(state);
  const servers = getElectrumServers(network);
  return { network, servers };
}

function getLastHealthyServer(): string | null {
  return readStorageItem(getPreferredStorage(), LAST_HEALTHY_SERVER_STORAGE_KEY);
}

function setLastHealthyServer(server: string): void {
  writeStorageItem(getPreferredStorage(), LAST_HEALTHY_SERVER_STORAGE_KEY, server);
}

function getBlockedUntil(server: string): number | undefined {
  const blockedUntil = blockedServers.get(server);
  if (!blockedUntil) return undefined;
  if (Date.now() >= blockedUntil) {
    blockedServers.delete(server);
    return undefined;
  }
  return blockedUntil;
}

function isServerBlocked(server: string): boolean {
  return getBlockedUntil(server) !== undefined;
}

function markServerFailed(server?: string | null): void {
  if (!server) return;
  blockedServers.set(server, Date.now() + SERVER_FAILURE_COOLDOWN_MS);
  recordServerFailure(server);
}

function markServerOk(server?: string | null, latencyMs = 0): void {
  if (!server) return;
  recordServerSuccess(server, latencyMs);
  setLastHealthyServer(server);
}

function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  label = 'operation'
): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    t = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms
    );
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

/** Timeout budget for a multi-call Electrum batch (proven too short at flat 12s×250). */
export function requestManyTimeoutMs(callCount: number): number {
  const n = Math.max(1, callCount);
  return Math.min(
    REQUEST_MANY_TIMEOUT_CAP_MS,
    REQUEST_TIMEOUT_MS + (n - 1) * REQUEST_MANY_PER_CALL_MS
  );
}

function bumpBackoff() {
  const jitter = 0.8 + Math.random() * 0.4;
  backoffMs = Math.min(Math.floor(backoffMs * 2 * jitter), BACKOFF_MAX_MS);
  nextAllowedConnectTs = Date.now() + backoffMs;
}

function resetBackoff() {
  backoffMs = BACKOFF_BASE_MS;
  nextAllowedConnectTs = 0;
}

function markSuccessfulActivity() {
  lastSuccessfulActivityTs = Date.now();
}

function subKey(method: string, params?: ElectrumParams): string {
  return `${method}:${JSON.stringify(params ?? [])}`;
}

function parseServerEntry(entry: string, defaultPort = WSS_PORT) {
  // Supports "wss://host:50004", "ws://host:50003", or just "host"
  if (entry.startsWith('ws://') || entry.startsWith('wss://')) {
    const u = new URL(entry);
    const host = u.hostname;
    const port = u.port
      ? Number(u.port)
      : u.protocol === 'wss:'
        ? 50004
        : 50003;
    const encrypted = u.protocol === 'wss:';
    return { host, port, encrypted };
  }
  const hostPort = entry.match(/^([^:]+):(\d{1,5})$/);
  if (hostPort) {
    return { host: hostPort[1], port: Number(hostPort[2]), encrypted: true };
  }
  return { host: entry, port: defaultPort, encrypted: true }; // default to WSS
}

function getNextServer(servers: string[], currentIdx: number): string | undefined {
  if (servers.length < 2) return undefined;
  const idx =
    currentIdx >= 0 && currentIdx < servers.length ? currentIdx : 0;
  return servers[(idx + 1) % servers.length];
}

function getPreferredServer(servers: string[]): string | undefined {
  if (servers.length === 0) return undefined;
  const lastHealthy = getLastHealthyServer();
  if (lastHealthy && servers.includes(lastHealthy) && !isServerBlocked(lastHealthy)) {
    return lastHealthy;
  }
  const firstAvailable = servers.find((server) => !isServerBlocked(server));
  return firstAvailable ?? servers[0];
}

function rotateFromIndex<T>(arr: T[], start: number): T[] {
  if (!arr.length) return arr;
  const idx = ((start % arr.length) + arr.length) % arr.length;
  return [...arr.slice(idx), ...arr.slice(0, idx)];
}

function orderServersForConnection(
  servers: string[],
  startIdx: number
): string[] {
  // Prefer last-known rotation start, then rank by multi-Fulcrum health scores
  // (latency EMA + success/fail). Blocked hosts sink to the end. Sticky
  // last-healthy keeps open scans from hopping after a few listunspent batches.
  const rotated = rotateFromIndex(servers, startIdx);
  return rankServersForConnect(rotated, {
    isBlocked: isServerBlocked,
    preferred: getLastHealthyServer() ?? currentServer,
  });
}

/** Per-call latency sample for health scoring (batch wall-clock / N). */
function perCallLatencyMs(wallMs: number, callCount: number): number {
  const n = Math.max(1, callCount);
  return Math.max(0, wallMs) / n;
}

function buildBatchMessage(
  calls: Array<{ id: number; method: string; params: ElectrumParams }>
): string {
  return JSON.stringify(
    calls.map(({ id, method, params }) => ({
      id,
      method,
      params,
    }))
  );
}

function canUseRawBatch(client: ECClient): client is ECClient & {
  requestId: number;
  requestResolvers: Record<
    number,
    (error?: Error, data?: RequestResponse) => void
  >;
  connection: {
    send: (message: string) => boolean;
  };
} {
  const candidate = client as ECClient & {
    requestId?: unknown;
    requestResolvers?: unknown;
    connection?: { send?: unknown };
  };

  return (
    typeof candidate.requestId === 'number' &&
    typeof candidate.requestResolvers === 'object' &&
    candidate.requestResolvers !== null &&
    typeof candidate.connection?.send === 'function'
  );
}

async function sendBatch(
  client: ECClient,
  calls: BatchRequest[]
): Promise<Array<RequestResponse | Error>> {
  if (!canUseRawBatch(client)) {
    return await Promise.all(
      calls.map(async ({ method, params = [] }) => {
        try {
          const result = await client.request(method, ...params);
          return result;
        } catch (error) {
          return error instanceof Error ? error : new Error(String(error));
        }
      })
    );
  }

  const batchCalls = calls.map(({ method, params = [] }) => {
    client.requestId += 1;
    return {
      id: client.requestId,
      method,
      params,
    };
  });

  const resolvers = batchCalls.map(
    ({ id }) =>
      new Promise<RequestResponse | Error>((resolve) => {
        client.requestResolvers[id] = (error?: Error, data?: RequestResponse) => {
          if (error) {
            resolve(error);
            return;
          }
          resolve(data as RequestResponse);
        };
      })
  );

  try {
    client.connection.send(buildBatchMessage(batchCalls));
  } catch (error) {
    for (const { id } of batchCalls) {
      delete client.requestResolvers[id];
    }
    throw error;
  }

  return await Promise.all(resolvers);
}

function isBatchTransportFailure(result: RequestResponse | Error): boolean {
  if (!(result instanceof Error)) return false;
  const message = result.message.toLowerCase();
  return (
    message.includes('connection lost') ||
    message.includes('not connected') ||
    message.includes('socket') ||
    message.includes('closed') ||
    message.includes('timed out') ||
    message.includes('network error') ||
    message.includes('econn')
  );
}

function throwIfBatchTransportFailed(
  results: Array<RequestResponse | Error>
): void {
  if (results.length === 0) return;
  const allTransportFailures = results.every(isBatchTransportFailure);
  if (allTransportFailures) {
    throw results[0];
  }
}

async function wireNotificationsOnce(client: ECClient) {
  if (notificationsWired) return;
  client.on('notification', (msg: Notification) => {
    for (const h of notificationHandlers) {
      try {
        h(msg);
      } catch {
        // isolate handler errors
      }
    }
  });
  notificationsWired = true;
}

// A dropped TCP socket does not auto-heal: ElectrumClient keeps this same
// instance alive after `disconnected`, so `electrumConnect()` would return the
// stale client and every request/batch would burn the full REQUEST_TIMEOUT_MS
// before the requestMany failover kicked in — a single disconnect turned one
// sync into minutes. Mark it stale so the next call reconnects immediately.
function markSocketStale(client: ECClient) {
  client.on('disconnected', () => {
    if (electrum === client) {
      electrum = null;
      currentServer = null;
    }
  });
}

/**
 * Replay active subscriptions after reconnect. Sequential await per address
 * made open/reconnect crawl once fusion (or HD discovery) grew the set —
 * hundreds of addresses × RTT. Parallelize in modest chunks.
 */
async function resubscribeAll() {
  if (!electrum) return;

  const simple: SubEntry[] = [];
  const parameterized: SubEntry[] = [];
  for (const entry of activeSubs.values()) {
    if (!entry.params || entry.params.length === 0) simple.push(entry);
    else parameterized.push(entry);
  }

  for (const { method } of simple) {
    try {
      await electrum.subscribe(method);
    } catch {
      /* best-effort */
    }
  }

  const RESUB_CONCURRENCY = 25;
  for (let i = 0; i < parameterized.length; i += RESUB_CONCURRENCY) {
    if (!electrum) return;
    const chunk = parameterized.slice(i, i + RESUB_CONCURRENCY);
    const client = electrum;
    await Promise.all(
      chunk.map(async ({ method, params }) => {
        try {
          if (!params || params.length === 0) {
            await client.subscribe(method);
          } else if (params.length === 1) {
            await client.subscribe(method, params[0]);
          } else {
            await client.request(method, ...params);
          }
        } catch {
          /* best-effort; keep going */
        }
      })
    );
  }
}

// ---------- API ----------
export default function ElectrumServer() {
  async function electrumConnect(customServer?: string): Promise<ECClient> {
    if (electrum) return electrum;

    const now = Date.now();
    if (now < nextAllowedConnectTs) {
      const wait = nextAllowedConnectTs - now;
      throw new Error(
        `Electrum reconnect backoff in effect. Retry in ${wait}ms`
      );
    }

    if (connectPromise) return connectPromise;

    const { servers } = getNetworkAndServers();

    // Build try order
    let startIdx = serverIndex;
    if (customServer) {
      const idx = servers.indexOf(customServer);
      startIdx = idx >= 0 ? idx : serverIndex;
    } else {
      const preferred = getPreferredServer(servers);
      if (preferred) {
        const preferredIdx = servers.indexOf(preferred);
        startIdx = preferredIdx >= 0 ? preferredIdx : serverIndex;
      }
    }
    const tryOrder = [
      ...servers.slice(startIdx),
      ...servers.slice(0, startIdx),
    ];
    const orderedServers = orderServersForConnection(tryOrder, 0);

    connectPromise = (async () => {
      try {
        const hostsThisRound = orderedServers.slice(0, MAX_CONNECT_HOSTS_PER_ROUND);
        for (let i = 0; i < hostsThisRound.length; i++) {
          const host = hostsThisRound[i];
          const { host: h, port, encrypted } = parseServerEntry(host, WSS_PORT);
          const socket = new ElectrumWebSocket(
            h,
            port,
            encrypted,
            CONNECT_TIMEOUT_MS
          );
          const client = new ElectrumClient<ElectrumClientEvents>(
            'OPTNWallet',
            '1.5.1',
            socket
          );

          try {
            const t0 = Date.now();
            await withTimeout(
              client.connect(),
              CONNECT_TIMEOUT_MS,
              `connect(${host})`
            );
            electrum = client;
            currentServer = host;
            serverIndex = servers.indexOf(host);
            markServerOk(host, Date.now() - t0);
            resetBackoff();
            markSuccessfulActivity();

            // Ensure notifications are wired and replay subs
            notificationsWired = false;
            await wireNotificationsOnce(electrum);
            await resubscribeAll();

            markSocketStale(electrum);

            return electrum!;
          } catch {
            markServerFailed(host);
            try {
              await client.disconnect(true);
            } catch {
              /* ignore */
            }
            // try next host
          }
        }
        // Advance the rotation so the next connect round tries different hosts.
        if (orderedServers.length > 0) {
          const lastTried = hostsThisRound[hostsThisRound.length - 1];
          const lastIdx = servers.indexOf(lastTried);
          if (lastIdx >= 0) {
            serverIndex = (lastIdx + 1) % servers.length;
          }
        }
        bumpBackoff();
        throw new Error('All Electrum servers failed to connect this round');
      } finally {
        connectPromise = null;
      }
    })();

    return connectPromise;
  }

  async function electrumDisconnect(): Promise<boolean> {
    if (electrum) {
      try {
        await electrum.disconnect(true);
      } catch {
        /* ignore */
      }
      electrum = null;
      currentServer = null;
      notificationsWired = false;
      return true;
    }
    return false;
  }

  async function ensureFreshConnection(): Promise<void> {
    if (!electrum) {
      await electrumConnect();
      return;
    }

    const idleFor = Date.now() - lastSuccessfulActivityTs;
    if (idleFor < IDLE_RECONNECT_AFTER_MS) return;

    try {
      const res = await withTimeout(
        electrum.request('server.ping'),
        REQUEST_TIMEOUT_MS,
        'server.ping'
      );
      if (res instanceof Error) throw res;
      markSuccessfulActivity();
    } catch {
      markServerFailed(currentServer ?? getLastHealthyServer());
      await electrumDisconnect();
      await electrumConnect();
    }
  }

  async function request(
    method: string,
    ...params: ElectrumParams
  ): Promise<RequestResponse> {
    await electrumConnect();
    try {
      const t0 = Date.now();
      const res = await withTimeout(
        electrum.request(method, ...params),
        REQUEST_TIMEOUT_MS,
        `request(${method})`
      );
      if (res instanceof Error) throw res;
      markServerOk(currentServer, Date.now() - t0);
      markSuccessfulActivity();
      return res;
    } catch (err) {
      markServerFailed(currentServer ?? getLastHealthyServer());
      const { servers } = getNetworkAndServers();
      // Health-ranked next hop (not only index+1). Prefer last healthy when set.
      const ranked = rankServersForConnect(servers, {
        isBlocked: isServerBlocked,
        preferred: getLastHealthyServer(),
      }).filter((s) => s !== currentServer);
      const nextServer = ranked[0] ?? getNextServer(servers, serverIndex);
      await electrumDisconnect();
      try {
        await electrumConnect(nextServer);
      } catch {
        throw err;
      }
      if (!electrum) {
        throw err;
      }
      const t1 = Date.now();
      const res = await withTimeout(
        electrum.request(method, ...params),
        REQUEST_TIMEOUT_MS,
        `request(${method})`
      );
      if (res instanceof Error) throw res;
      markServerOk(currentServer, Date.now() - t1);
      markSuccessfulActivity();
      return res;
    }
  }

  async function requestMany(
    calls: BatchRequest[]
  ): Promise<Array<RequestResponse | Error>> {
    if (calls.length === 0) return [];

    const budgetMs = requestManyTimeoutMs(calls.length);
    await electrumConnect();
    await ensureFreshConnection();
    try {
      const t0 = Date.now();
      const results = await withTimeout(
        sendBatch(electrum!, calls),
        budgetMs,
        `requestMany(${calls.length})`
      );
      throwIfBatchTransportFailed(results);
      const failedIndices = results.flatMap((result, index) =>
        isBatchTransportFailure(result) ? [index] : []
      );
      if (failedIndices.length > 0) {
        const failedServer = currentServer;
        markServerFailed(failedServer ?? getLastHealthyServer());
        const { servers } = getNetworkAndServers();
        const ranked = rankServersForConnect(servers, {
          isBlocked: isServerBlocked,
          preferred: getLastHealthyServer(),
        }).filter((server) => server !== failedServer);
        const nextServer = ranked[0] ?? getNextServer(servers, serverIndex);
        try {
          await electrumDisconnect();
          await electrumConnect(nextServer);
          const retryCalls = failedIndices.map((index) => calls[index]);
          const retryResults = await withTimeout(
            sendBatch(electrum!, retryCalls),
            requestManyTimeoutMs(retryCalls.length),
            `requestMany(${retryCalls.length}) retry`
          );
          throwIfBatchTransportFailed(retryResults);
          retryResults.forEach((result, retryIndex) => {
            results[failedIndices[retryIndex]] = result;
          });
        } catch {
          // Preserve successful members. Failed slots remain Error values so
          // callers keep prior wallet state rather than treating them as empty.
          return results;
        }
      }
      // Score per-call average — full batch wall-clock made busy healthy hosts
      // look slower than idle untried peers after every open listunspent.
      markServerOk(
        currentServer,
        perCallLatencyMs(Date.now() - t0, calls.length)
      );
      markSuccessfulActivity();
      return results;
    } catch (err) {
      markServerFailed(currentServer ?? getLastHealthyServer());
      const { servers } = getNetworkAndServers();
      const ranked = rankServersForConnect(servers, {
        isBlocked: isServerBlocked,
        preferred: getLastHealthyServer(),
      }).filter((s) => s !== currentServer);
      const nextServer = ranked[0] ?? getNextServer(servers, serverIndex);
      await electrumDisconnect();
      try {
        await electrumConnect(nextServer);
      } catch {
        throw err;
      }
      if (!electrum) {
        throw err;
      }
      const t1 = Date.now();
      const results = await withTimeout(
        sendBatch(electrum!, calls),
        budgetMs,
        `requestMany(${calls.length})`
      );
      throwIfBatchTransportFailed(results);
      markServerOk(
        currentServer,
        perCallLatencyMs(Date.now() - t1, calls.length)
      );
      markSuccessfulActivity();
      return results;
    }
  }

  /**
   * Batch-subscribe to a method for many params in a single round-trip.
   * Records every sub in activeSubs so reconnect resubscribes them all.
   * Used instead of N sequential `subscribe()` calls when a wallet has many
   * addresses — e.g. an Electrum Cash wallet with hundreds of derived keys.
   */
  async function subscribeMany(
    method: string,
    paramsList: ElectrumParams[]
  ): Promise<number> {
    if (paramsList.length === 0) return 0;

    // Oversized single batches are rejected in an ID-null error by ElectrumX/
    // Fulcrum (verified live: a 1086-item batch crashes the client). Split into
    // moderate chunks. Keep size aligned with ElectrumService UTXO batches so
    // the scaled requestMany timeout stays sufficient.
    const SUB_BATCH_SIZE = 50;
    const chunkedParams: ElectrumParams[][] = [];
    for (let i = 0; i < paramsList.length; i += SUB_BATCH_SIZE) {
      chunkedParams.push(paramsList.slice(i, i + SUB_BATCH_SIZE));
    }

    const outcomeBatches = await Promise.all(
      chunkedParams.map((chunkParams) => {
        const calls: BatchRequest[] = chunkParams.map((params) => ({
          method,
          params,
        }));
        return requestMany(calls);
      })
    );

    // record whatever actually succeeded
    let recorded = 0;
    outcomeBatches.forEach((outcomes, batchIndex) => {
      const chunkParams = chunkedParams[batchIndex];
      for (let i = 0; i < chunkParams.length; i++) {
        const result = outcomes[i];
        if (result instanceof Error) continue;
        const key = subKey(method, chunkParams[i]);
        activeSubs.set(key, { method, params: chunkParams[i] });
        recorded++;
      }
    });
    if (recorded > 0) markSuccessfulActivity();
    return recorded;
  }

  async function electrumReconnect(customServer?: string): Promise<ECClient> {
    await electrumDisconnect();
    return electrumConnect(customServer);
  }

  /**
   * Subscribe to Electrum notifications for a given method.
   * Examples:
   *   subscribe('blockchain.headers.subscribe')                        // new blocks
   *   subscribe('blockchain.scripthash.subscribe', scripthash)         // script activity
   *   subscribe('blockchain.address.subscribe', 'bitcoincash:qq...')   // address activity (Electrum Cash)
   */
  async function subscribe(method: string, params?: ElectrumParams): Promise<void> {
    await electrumConnect();
    const key = subKey(method, params);

    const doSubscribe = async () => {
      if (!params || params.length === 0) {
        await electrum!.subscribe(method);
      } else if (params.length === 1) {
        await electrum!.subscribe(method, params[0]);
      } else {
        await electrum!.request(method, ...params);
      }
    };

    try {
      await doSubscribe();
      activeSubs.set(key, { method, params });
      markSuccessfulActivity();
    } catch (err) {
      markServerFailed(currentServer ?? getLastHealthyServer());
      const { servers } = getNetworkAndServers();
      const ranked = rankServersForConnect(servers, {
        isBlocked: isServerBlocked,
        preferred: getLastHealthyServer(),
      }).filter((s) => s !== currentServer);
      const nextServer = ranked[0] ?? getNextServer(servers, serverIndex);
      await electrumDisconnect();
      try {
        await electrumConnect(nextServer);
      } catch {
        throw err;
      }
      if (!electrum) {
        throw err;
      }
      await doSubscribe();
      activeSubs.set(key, { method, params });
      markServerOk(currentServer);
      markSuccessfulActivity();
    }
  }

  /**
   * Unsubscribe:
   * - For Electrum Cash address subscriptions, call RPC unsubscribe.
   * - For scripthash & headers, servers typically don't expose a generic unsubscribe.
   *   We remove from local registry so we won't resubscribe on reconnect.
   */
  async function unsubscribe(method: string, params?: ElectrumParams): Promise<void> {
    await electrumConnect();
    const key = subKey(method, params);
    activeSubs.delete(key);

    if (method === 'blockchain.address.subscribe') {
      try {
        // Some servers support this Electrum Cash extension; ignore failures.
        await electrum.request(
          'blockchain.address.unsubscribe',
          ...(params ?? [])
        );
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Register a notification handler (fan-out).
   * Returns a disposer to deregister.
   */
  function onNotification(handler: NotificationHandler): () => void {
    notificationHandlers.add(handler);
    return () => notificationHandlers.delete(handler);
  }

  function getCurrentServer(): string | null {
    return currentServer;
  }

  function getServerList(): string[] {
    return getNetworkAndServers().servers;
  }

  /** Multi-Fulcrum health scores (for settings/debug). */
  function getReliabilitySnapshot(): {
    current: string | null;
    servers: string[];
    health: ReturnType<typeof getAllServerHealth>;
  } {
    return {
      current: currentServer,
      servers: getNetworkAndServers().servers,
      health: getAllServerHealth(),
    };
  }

  return {
    electrumConnect,
    electrumReconnect,
    electrumDisconnect,
    ensureFreshConnection,
    request,
    requestMany,
    subscribe,
    subscribeMany,
    unsubscribe,
    onNotification,
    getCurrentServer,
    getServerList,
    getReliabilitySnapshot,
  };
}
