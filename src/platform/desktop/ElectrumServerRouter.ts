// Desktop transport router — makes the wallet backend-AGNOSTIC and EXCLUSIVE.
//
// Swapped in for the upstream ElectrumServer (vite.desktop.config.ts), so
// ElectrumService and every caller above it are untouched: same factory, same
// { request, requestMany, subscribe, ... } shape. The difference is where wallet
// data comes from:
//
//   backend = auto / server  -> delegate to the real ElectrumServer (Fulcrum),
//                               which keeps its own pool failover.
//   backend = node           -> answer wallet-data queries from a BIP37 scan of
//                               that node (trustless: each match proven by its
//                               block's merkle proof). Electrum is NOT consulted
//                               for those queries — one backend at a time.
//
// A node can't answer everything (it has no address index), so protocol/chore
// methods still go to Electrum. Anything the node genuinely can't serve falls
// back rather than breaking the wallet.
//
// NOTE: the swap plugin deliberately lets a replacement import the module it
// replaces (importer === target short-circuits), so the import below resolves to
// the REAL upstream ElectrumServer, not back into this file.
import UpstreamElectrumServer from '../../apis/ElectrumServer/ElectrumServer';
import type { RequestResponse } from '@electrum-cash/network';
import { store } from '../../state/store';
import { selectCurrentNetwork } from '../../state/selectors/networkSelectors';
import { getBackend } from './backendSelection';
import { nodeSync, nodeBroadcast, type NodeSyncResult } from './Bip37Backend';
import { parseNodeTarget } from '../../utils/servers/userNodes';
import { getElectrumServers } from '../../utils/servers/ElectrumServers';
import { selectWalletId } from '../../state/slices/walletSlice';
import { Network } from '../../state/slices/networkSlice';

type ElectrumParams = RequestResponse[];

/** Methods whose first param is a CashAddr. */
const ADDRESS_METHOD_PREFIX = 'blockchain.address.';

/**
 * Reject an address that belongs to a different chain than the one we're on.
 *
 * Several wallet-scoped tables outlive a network switch (quantumroot_vaults,
 * cashscript_addresses, instantiated_contracts are never cleared), and address
 * discovery derives from the global redux network, which is reconciled with the
 * wallet's own networkType only by an async effect. So a mainnet `bitcoincash:`
 * address can reach a chipnet server.
 *
 * That is not a harmless miss. The server answers "Invalid address" and drops
 * the socket, so every in-flight query for the addresses that ARE valid fails
 * with "Connection lost" and the wallet renders empty on BOTH chains. And since
 * subscribe() records the address in the resubscribe-on-reconnect registry, each
 * reconnect re-sends it and re-breaks the fresh socket — the loop never settles.
 *
 * A CashAddr names its own network in its prefix, so this is decidable locally:
 * keep the mismatch off the wire instead of letting the server hang up on us.
 */
function assertOnCurrentNetwork(
  method: string,
  params: ElectrumParams | undefined,
  network: Network
): void {
  if (!method.startsWith(ADDRESS_METHOD_PREFIX)) return;
  const address = String(params?.[0] ?? '');
  const sep = address.indexOf(':');
  if (sep <= 0) return; // prefixless — the server resolves it on its own network
  const prefix = address.slice(0, sep).toLowerCase();
  const expected = network === Network.MAINNET ? 'bitcoincash' : 'bchtest';
  if (prefix !== expected) {
    throw new Error(
      `[network guard] ${address} is a ${prefix} address; wallet is on ${network} ` +
        `(${expected}). Not sent — a cross-network address makes the server drop the connection.`
    );
  }
}

// Wallet-data methods a BIP37 node scan can answer.
const UNSPENT_METHODS = new Set([
  'blockchain.address.listunspent',
  'blockchain.scripthash.listunspent',
]);
const BALANCE_METHODS = new Set([
  'blockchain.address.get_balance',
  'blockchain.scripthash.get_balance',
]);
const BROADCAST_METHOD = 'blockchain.transaction.broadcast';

/** A node scan is expensive; reuse it briefly across the burst of per-address calls. */
const SCAN_TTL_MS = 30_000;
let scanCache: { key: string; at: number; result: NodeSyncResult } | null = null;
let inflight: Promise<NodeSyncResult> | null = null;

async function scanFor(target: string, walletId: number): Promise<NodeSyncResult> {
  const network = selectCurrentNetwork(store.getState());
  const key = `${target}|${network}|${walletId}`;
  const now = Date.now();
  if (scanCache && scanCache.key === key && now - scanCache.at < SCAN_TTL_MS) {
    return scanCache.result;
  }
  if (inflight) return inflight;

  const { host, port } = parseNodeTarget(target, network);
  inflight = (async () => {
    try {
      const result = await nodeSync(host, port, network, walletId);
      scanCache = { key, at: Date.now(), result };
      return result;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Drop the cached scan (e.g. after a broadcast or a backend/network change). */
export function invalidateNodeScan(): void {
  scanCache = null;
}

/**
 * Upstream ElectrumServer keeps a process-wide socket and only reconnects on
 * idle/failed ping (`if (electrum) return electrum`). Menu lock and same-window
 * wallet switches do not always disconnect, so a chipnet wallet can keep
 * talking to a mainnet Fulcrum host — scripthash listunspent/history then
 * return empty and the UI shows permanent 0 balance / "No activity yet".
 *
 * If the live host is not in the *current* network pool, drop it so the next
 * connect/request rebuilds against the right servers.
 */
async function dropStaleNetworkSocket(
  upstream: ReturnType<typeof UpstreamElectrumServer>
): Promise<void> {
  const network = selectCurrentNetwork(store.getState());
  const servers = getElectrumServers(network);
  if (servers.length === 0) return;
  const current =
    typeof upstream.getCurrentServer === 'function'
      ? upstream.getCurrentServer()
      : null;
  if (!current || servers.includes(current)) return;
  try {
    await upstream.electrumDisconnect();
  } catch {
    /* best-effort; next connect rebuilds */
  }
}

export default function ElectrumServer() {
  const upstream = UpstreamElectrumServer();

  async function ensureFreshConnection(): Promise<void> {
    await dropStaleNetworkSocket(upstream);
    return upstream.ensureFreshConnection();
  }

  async function request(method: string, ...params: ElectrumParams): Promise<RequestResponse> {
    await dropStaleNetworkSocket(upstream);
    const network = selectCurrentNetwork(store.getState());
    assertOnCurrentNetwork(method, params, network);
    const backend = getBackend(network);

    // Only a pinned node diverts wallet data; auto/server keep today's path.
    if (backend.kind !== 'node') return upstream.request(method, ...params);

    const walletId = selectWalletId(store.getState());
    if (!walletId || walletId <= 0) return upstream.request(method, ...params);

    if (method === BROADCAST_METHOD) {
      const { host, port } = parseNodeTarget(backend.target, network);
      const txid = await nodeBroadcast(host, port, network, String(params[0] ?? ''));
      invalidateNodeScan(); // our UTXO set just changed
      return txid as unknown as RequestResponse;
    }

    if (UNSPENT_METHODS.has(method) || BALANCE_METHODS.has(method)) {
      const address = String(params[0] ?? '');
      const scan = await scanFor(backend.target, walletId);
      const utxos = scan.byAddress.get(address) ?? [];

      if (BALANCE_METHODS.has(method)) {
        const confirmed = utxos.reduce((sum, u) => sum + u.value, 0);
        return { confirmed, unconfirmed: 0 } as unknown as RequestResponse;
      }
      // Electrum listunspent shape, so mapUtxoRows upstream keeps working.
      return utxos.map((u) => ({
        tx_hash: u.txid,
        tx_pos: u.vout,
        value: u.value,
        height: 0,
      })) as unknown as RequestResponse;
    }

    // Everything else (headers, tx.get, server.*, subscribe chores) has no BIP37
    // equivalent — a node has no address index — so use Electrum for those.
    return upstream.request(method, ...params);
  }

  async function requestMany(
    calls: Array<{ method: string; params?: ElectrumParams }>
  ): Promise<Array<RequestResponse | Error>> {
    await dropStaleNetworkSocket(upstream);
    const network = selectCurrentNetwork(store.getState());

    // Drop cross-network addresses from the batch rather than letting one bad
    // entry hang up the socket and take the whole batch down with it. Results
    // stay index-aligned with `calls`: the offenders get an Error in place.
    const results = new Array<RequestResponse | Error>(calls.length);
    const forward: Array<{ method: string; params?: ElectrumParams }> = [];
    const forwardIndex: number[] = [];
    calls.forEach((call, i) => {
      try {
        assertOnCurrentNetwork(call.method, call.params, network);
        forward.push(call);
        forwardIndex.push(i);
      } catch (e) {
        results[i] = e instanceof Error ? e : new Error(String(e));
      }
    });

    if (forward.length > 0) {
      const answered =
        getBackend(network).kind !== 'node'
          ? await upstream.requestMany(forward)
          : // Serve the batch through the node path (one shared scan via the cache).
            await Promise.all(
              forward.map(async ({ method, params = [] }) => {
                try {
                  return await request(method, ...params);
                } catch (e) {
                  return e instanceof Error ? e : new Error(String(e));
                }
              })
            );
      answered.forEach((r, j) => {
        results[forwardIndex[j]] = r;
      });
    }

    return results;
  }

  // Guarded too, and this is the important one: an address that reaches
  // upstream.subscribe() enters the resubscribe-on-reconnect registry, where it
  // re-breaks every future socket long after the switch that produced it.
  async function subscribe(method: string, params?: ElectrumParams): Promise<void> {
    await dropStaleNetworkSocket(upstream);
    assertOnCurrentNetwork(method, params, selectCurrentNetwork(store.getState()));
    return upstream.subscribe(method, params);
  }

  return { ...upstream, request, requestMany, subscribe, ensureFreshConnection };
}
