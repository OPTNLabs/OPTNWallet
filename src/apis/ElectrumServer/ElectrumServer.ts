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
import { store } from '../../redux/store';
import { selectCurrentNetwork } from '../../redux/selectors/networkSelectors';
import { Network } from '../../redux/networkSlice';

// ---------- Config ----------
const CONNECT_TIMEOUT_MS = 8000;
const REQUEST_TIMEOUT_MS = 12000;
const BACKOFF_BASE_MS = 3000;
const BACKOFF_MAX_MS = 60000;
const WSS_PORT = 50004;
const IDLE_RECONNECT_AFTER_MS = 5 * 60 * 1000;

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

function getNetworkAndServers(): { network: Network; servers: string[] } {
  const state = store.getState();
  const network = selectCurrentNetwork(state);
  const servers = getElectrumServers(network);
  return { network, servers };
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
  return { host: entry, port: defaultPort, encrypted: true }; // default to WSS
}

function getNextServer(servers: string[], currentIdx: number): string | undefined {
  if (servers.length < 2) return undefined;
  const idx =
    currentIdx >= 0 && currentIdx < servers.length ? currentIdx : 0;
  return servers[(idx + 1) % servers.length];
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

async function resubscribeAll() {
  if (!electrum) return;

  for (const { method, params } of activeSubs.values()) {
    try {
      if (!params || params.length === 0) {
        await electrum.subscribe(method);
      } else if (params.length === 1) {
        await electrum.subscribe(method, params[0]);
      } else {
        await electrum.request(method, ...params);
      }
    } catch {
      // best-effort; keep going
    }
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
    }
    const tryOrder = [
      ...servers.slice(startIdx),
      ...servers.slice(0, startIdx),
    ];

    connectPromise = (async () => {
      try {
        for (let i = 0; i < tryOrder.length; i++) {
          const host = tryOrder[i];
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
            await withTimeout(
              client.connect(),
              CONNECT_TIMEOUT_MS,
              `connect(${host})`
            );
            electrum = client;
            serverIndex = servers.indexOf(host);
            resetBackoff();
            markSuccessfulActivity();

            // Ensure notifications are wired and replay subs
            notificationsWired = false;
            await wireNotificationsOnce(electrum);
            await resubscribeAll();

            return electrum!;
          } catch {
            try {
              await client.disconnect(true);
            } catch {
              /* ignore */
            }
            // try next host
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
      const res = await withTimeout(
        electrum.request(method, ...params),
        REQUEST_TIMEOUT_MS,
        `request(${method})`
      );
      if (res instanceof Error) throw res;
      markSuccessfulActivity();
      return res;
    } catch (err) {
      const { servers } = getNetworkAndServers();
      const nextServer = getNextServer(servers, serverIndex);
      await electrumDisconnect();
      await electrumConnect(nextServer); // may throw if backoff is active
      const res = await withTimeout(
        electrum.request(method, ...params),
        REQUEST_TIMEOUT_MS,
        `request(${method})`
      );
      if (res instanceof Error) throw res;
      markSuccessfulActivity();
      return res;
    }
  }

  async function requestMany(
    calls: BatchRequest[]
  ): Promise<Array<RequestResponse | Error>> {
    if (calls.length === 0) return [];

    await electrumConnect();
    await ensureFreshConnection();
    try {
      return await withTimeout(
        sendBatch(electrum!, calls),
        REQUEST_TIMEOUT_MS,
        `requestMany(${calls.length})`
      );
    } catch {
      const { servers } = getNetworkAndServers();
      const nextServer = getNextServer(servers, serverIndex);
      await electrumDisconnect();
      await electrumConnect(nextServer);
      return await withTimeout(
        sendBatch(electrum!, calls),
        REQUEST_TIMEOUT_MS,
        `requestMany(${calls.length})`
      );
    }
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
  } catch {
      const { servers } = getNetworkAndServers();
      const nextServer = getNextServer(servers, serverIndex);
      await electrumDisconnect();
      await electrumConnect(nextServer);
      await doSubscribe();
      activeSubs.set(key, { method, params });
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

  return {
    electrumConnect,
    electrumReconnect,
    electrumDisconnect,
    ensureFreshConnection,
    request,
    requestMany,
    subscribe,
    unsubscribe,
    onNotification,
  };
}
