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
import { selectWalletId } from '../../state/slices/walletSlice';

type ElectrumParams = RequestResponse[];

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

export default function ElectrumServer() {
  const upstream = UpstreamElectrumServer();

  async function request(method: string, ...params: ElectrumParams): Promise<RequestResponse> {
    const network = selectCurrentNetwork(store.getState());
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
    const network = selectCurrentNetwork(store.getState());
    if (getBackend(network).kind !== 'node') return upstream.requestMany(calls);
    // Serve the batch through the node path (one shared scan via the cache).
    return Promise.all(
      calls.map(async ({ method, params = [] }) => {
        try {
          return await request(method, ...params);
        } catch (e) {
          return e instanceof Error ? e : new Error(String(e));
        }
      })
    );
  }

  return { ...upstream, request, requestMany };
}
