import {
  ElectrumClient,
  // ElectrumTransport,
  RequestResponse,
} from '@electrum-cash/network';
import { ElectrumWebSocket } from '@electrum-cash/web-socket';
import {
  chipnetServers,
  mainnetServers,
} from '../../utils/servers/ElectrumServers';
import { store } from '../../redux/store';
import { selectCurrentNetwork } from '../../redux/selectors/networkSelectors';
import { Network } from '../../redux/networkSlice';

// ---------- Config ----------
const CONNECT_TIMEOUT_MS = 8000;
const BACKOFF_BASE_MS = 3000;
const BACKOFF_MAX_MS = 60000;
const WSS_PORT = 50004;

// ---------- Internal state ----------
let electrum: ElectrumClient | null = null;
let connectPromise: Promise<ElectrumClient> | null = null;
let serverIndex = 0;
let backoffMs = BACKOFF_BASE_MS;
let nextAllowedConnectTs = 0;

// Make sure we only wire 'notification' once per client instance
let notificationsWired = false;

// Fan-out of notification listeners (UI, services, etc.)
type Notification = { jsonrpc: '2.0'; method: string; params: any[] };
type NotificationHandler = (n: Notification) => void;
const notificationHandlers = new Set<NotificationHandler>();

// Registry of active subscriptions for resubscribe-on-reconnect
// We key by method + JSON.stringify(params)
type SubEntry = { method: string; params?: any[] };
const activeSubs = new Map<string, SubEntry>();

function getNetworkAndServers(): { network: Network; servers: string[] } {
  const state = store.getState();
  const network = selectCurrentNetwork(state);
  const servers = network === Network.MAINNET ? mainnetServers : chipnetServers;
  return { network, servers };
}

function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  label = 'operation'
): Promise<T> {
  let t: any;
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

function subKey(method: string, params?: any[]): string {
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

async function wireNotificationsOnce(client: ElectrumClient) {
  if (notificationsWired) return;
  client.on('notification', (msg: Notification) => {
    // Fan-out to subscribers
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
        await electrum.subscribe(method); // no arg at all
      } else if (params.length === 1) {
        await electrum.subscribe(method, params[0]); // pass the single value
      } else {
        // If a method ever needs >1 args, go through request()
        await electrum.request(method, ...params);
      }
    } catch {
      // best-effort; keep going
    }
  }
}


// ---------- API ----------
export default function ElectrumServer() {
  async function electrumConnect(
    customServer?: string
  ): Promise<ElectrumClient> {
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
          const client = new ElectrumClient('OPTNWallet', '1.5.1', socket);
          // const client = new ElectrumClient(
          //   'OPTNWallet',
          //   '1.5.1',
          //   host,
          //   WSS_PORT,
          //   ElectrumTransport.WSS.Scheme
          // );

          try {
            await withTimeout(
              client.connect(),
              CONNECT_TIMEOUT_MS,
              `connect(${host})`
            );
            electrum = client;
            serverIndex = servers.indexOf(host);
            resetBackoff();

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

  async function request(
    method: string,
    ...params: any[]
  ): Promise<RequestResponse> {
    await electrumConnect();
    try {
      return await electrum.request(method, ...params);
    } catch (err) {
      await electrumDisconnect();
      await electrumConnect(); // may throw if backoff is active
      return await electrum.request(method, ...params);
    }
  }

  /**
   * Subscribe to Electrum notifications for a given method.
   * Examples:
   *   subscribe('blockchain.headers.subscribe')                        // new blocks
   *   subscribe('blockchain.scripthash.subscribe', scripthash)         // script activity
   *   subscribe('blockchain.address.subscribe', 'bitcoincash:qq...')   // address activity (Electrum Cash)
   */
  async function subscribe(method: string, params?: any[]): Promise<void> {
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
  } catch {
    await electrumDisconnect();
    await electrumConnect();
    await doSubscribe();
    activeSubs.set(key, { method, params });
  }
}


  /**
   * Unsubscribe:
   * - For Electrum Cash address subscriptions, call RPC unsubscribe.
   * - For scripthash & headers, servers typically don't expose a generic unsubscribe.
   *   We remove from local registry so we won't resubscribe on reconnect.
   */
  async function unsubscribe(method: string, params?: any[]): Promise<void> {
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
      } catch {}
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
    electrumDisconnect,
    request,
    subscribe,
    unsubscribe,
    onNotification,
  };
}
