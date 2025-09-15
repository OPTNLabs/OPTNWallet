import {
  ElectrumClient,
  ElectrumTransport,
  RequestResponse,
} from 'electrum-cash';
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
type SubEntry = { method: string; params: any[] };
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

function subKey(method: string, params: any[] = []): string {
  return `${method}:${JSON.stringify(params ?? [])}`;
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
  // Replay every active subscription on the live client
  for (const { method, params } of activeSubs.values()) {
    try {
      await electrum.subscribe(method, ...(params ?? []));
    } catch {
      // If a sub fails, keep going — caller handlers will still see future attempts
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
          const client = new ElectrumClient(
            'OPTNWallet',
            '1.5.1',
            host,
            WSS_PORT,
            ElectrumTransport.WSS.Scheme
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
  async function subscribe(method: string, ...params: any[]): Promise<void> {
    await electrumConnect();
    const key = subKey(method, params);
    try {
      await electrum.subscribe(method, ...params);
      activeSubs.set(key, { method, params });
    } catch (err) {
      // Retry once on a fresh connection
      await electrumDisconnect();
      await electrumConnect();
      await electrum.subscribe(method, ...params);
      activeSubs.set(key, { method, params });
    }
  }

  /**
   * Unsubscribe:
   * - For Electrum Cash address subscriptions, call RPC unsubscribe.
   * - For scripthash & headers, servers typically don't expose a generic unsubscribe.
   *   We remove from local registry so we won't resubscribe on reconnect.
   */
  async function unsubscribe(method: string, ...params: any[]): Promise<void> {
    await electrumConnect();
    const key = subKey(method, params);
    activeSubs.delete(key);

    // Best-effort RPC unsubscribe for address flavor (Electrum Cash extension).
    if (method === 'blockchain.address.subscribe') {
      try {
        await electrum.request('blockchain.address.unsubscribe', ...params);
      } catch {
        /* some servers may not support unsubscribe; ignore */
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
    electrumDisconnect,
    request,
    subscribe,
    unsubscribe,
    onNotification,
  };
}
