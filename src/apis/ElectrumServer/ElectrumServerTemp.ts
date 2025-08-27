/**
 * ElectrumServer.ts
 *
 * Low-level manager for connecting to ElectrumX servers via electrum-cash.
 * Provides:
 *  - Reliable connection management (single client instance)
 *  - Exponential backoff on failure with jitter
 *  - Timeout handling for connection attempts
 *  - Request forwarding with automatic retry on failure
 *
 * This acts as the socket/SPV backbone for higher-level ElectrumService methods.
 *
 * ⚠️ Note: Using deprecated electrum-cash package. Some RPC methods may diverge
 * from newer ElectrumX servers (e.g., address vs scripthash subscriptions).
 */

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
const CONNECT_TIMEOUT_MS = 8000;      // Timeout per connection attempt
const BACKOFF_BASE_MS = 3000;         // Initial backoff delay
const BACKOFF_MAX_MS = 60000;         // Max backoff delay
const WSS_PORT = 50004;               // Default Electrum SSL WebSocket port

// ---------- Internal state ----------
let electrum: ElectrumClient | null = null;                    // Active client instance
let connectPromise: Promise<ElectrumClient> | null = null;      // Shared connection attempt
let serverIndex = 0;                                            // Last successful server index
let backoffMs = BACKOFF_BASE_MS;                                // Current backoff time
let nextAllowedConnectTs = 0;                                   // Timestamp when next connect is allowed

/**
 * Chooses the current network (mainnet or chipnet) and returns
 * the corresponding list of Electrum servers.
 */
function getNetworkAndServers(): { network: Network; servers: string[] } {
  const state = store.getState();
  const network = selectCurrentNetwork(state);
  const servers = network === Network.MAINNET ? mainnetServers : chipnetServers;
  return { network, servers };
}

/**
 * Wraps a promise with a timeout rejection.
 *
 * @param p - The promise to wrap
 * @param ms - Timeout in milliseconds
 * @param label - Label for error messages
 * @returns A promise that rejects if not resolved within `ms`
 */
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

/**
 * Applies exponential backoff with random jitter.
 * Called after all servers fail to connect.
 */
function bumpBackoff() {
  const jitter = 0.8 + Math.random() * 0.4;
  backoffMs = Math.min(Math.floor(backoffMs * 2 * jitter), BACKOFF_MAX_MS);
  nextAllowedConnectTs = Date.now() + backoffMs;
}

/**
 * Resets backoff after successful connection.
 */
function resetBackoff() {
  backoffMs = BACKOFF_BASE_MS;
  nextAllowedConnectTs = 0;
}

// ---------- API ----------
export default function ElectrumServer() {
  /**
   * Establish a connection to an Electrum server.
   * - Reuses existing client if connected
   * - Enforces exponential backoff after repeated failures
   * - Shares a single connectPromise to avoid duplicate connects
   *
   * @param customServer Optional server hostname to prioritize
   * @returns {Promise<ElectrumClient>} Connected Electrum client
   * @throws Error if backoff is active or all servers fail
   */
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

    // Build try order for round-robin failover
    let startIdx = serverIndex;
    if (customServer) {
      const idx = servers.indexOf(customServer);
      startIdx = idx >= 0 ? idx : serverIndex;
    }
    const tryOrder = [
      ...servers.slice(startIdx),
      ...servers.slice(0, startIdx),
    ];

    // Connection attempt
    connectPromise = (async () => {
      try {
        for (const host of tryOrder) {
          const client = new ElectrumClient(
            'OPTNWallet',
            '1.5.1',
            host,
            WSS_PORT,
            ElectrumTransport.WSS.Scheme
          );

          try {
            await withTimeout(client.connect(), CONNECT_TIMEOUT_MS, `connect(${host})`);
            electrum = client;
            serverIndex = servers.indexOf(host);
            resetBackoff();
            return electrum!;
          } catch {
            try { await client.disconnect(true); } catch {}
            // continue to next server
          }
        }

        // All failed
        bumpBackoff();
        throw new Error('All Electrum servers failed to connect this round');
      } finally {
        // Always clear connectPromise so new attempts can start later
        connectPromise = null;
      }
    })();

    return connectPromise;
  }

  /**
   * Disconnect the active Electrum client, if any.
   *
   * @returns {Promise<boolean>} True if client disconnected, false if none
   */
  async function electrumDisconnect(): Promise<boolean> {
    if (electrum) {
      try { await electrum.disconnect(true); } catch {}
      electrum = null;
      return true;
    }
    return false;
  }

  /**
   * Perform an RPC request via the Electrum client.
   * If the request fails, attempts a fresh reconnect and retries once.
   *
   * @param method Electrum RPC method name
   * @param params RPC parameters
   * @returns {Promise<RequestResponse>} RPC result
   */
  async function request(
    method: string,
    ...params: any[]
  ): Promise<RequestResponse> {
    await electrumConnect();
    try {
      return await electrum.request(method, ...params);
    } catch {
      await electrumDisconnect();
      await electrumConnect(); // may throw if backoff is active
      return await electrum.request(method, ...params);
    }
  }

  return { electrumConnect, electrumDisconnect, request };
}
