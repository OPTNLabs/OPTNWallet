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
// let isConnecting = false;
let connectPromise: Promise<ElectrumClient> | null = null; // <-- NEW
let serverIndex = 0;
let backoffMs = BACKOFF_BASE_MS;
let nextAllowedConnectTs = 0;

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

// ---------- API ----------
export default function ElectrumServer() {
  async function electrumConnect(
    customServer?: string
  ): Promise<ElectrumClient> {
    if (electrum) return electrum;

    const now = Date.now();
    if (now < nextAllowedConnectTs) {
      const wait = nextAllowedConnectTs - now;
      // Backoff in effect; fail fast so callers can handle gracefully
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

    // isConnecting = true;
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
        // isConnecting = false;
        // Important: clear so future callers can initiate a new connection
        const ok = !!electrum;
        // Only clear the promise after we set electrum or finish failing
        connectPromise = null; // <-- CHANGED
        if (!ok) {
          // keep electrum as null on failure
        }
      }
    })();

    return connectPromise; // <-- CHANGED
  }

  async function electrumDisconnect(): Promise<boolean> {
    if (electrum) {
      try {
        await electrum.disconnect(true);
      } catch {
        /* ignore */
      }
      electrum = null;
      return true;
    }
    return false;
  }

  async function request(
    method: string,
    ...params: any[]
  ): Promise<RequestResponse> {
    // Ensure connected (may wait on an in-flight connect)
    await electrumConnect();

    try {
      return await electrum.request(method, ...params);
    } catch (err) {
      // Retry once on a fresh connection
      await electrumDisconnect();
      await electrumConnect(); // may throw if backoff is active
      return await electrum.request(method, ...params);
    }
  }

  return { electrumConnect, electrumDisconnect, request };
}