// BIP37 node backend — serves wallet data straight from a full node (bchd) over
// P2P, so a node in the server pool can back the wallet like a Fulcrum server.
//
// Read path: sync block headers from the node, then bloom-filter scan those
// blocks for the wallet's watched pubkey-hashes; each matched tx is proven to be
// in its block by the merkleblock's partial merkle tree (verified in Rust), so
// this is trustless — no server is asked to be honest about our balance.
// Write path: broadcast a signed tx to the node over P2P.
//
// The Rust side (spv::*) does the protocol + verification; this module gathers
// the wallet's watched hashes, drives the header/scan calls, and folds the
// result into an address -> UTXO index.

import { invoke } from '@tauri-apps/api/core';
import { Network } from '../../state/slices/networkSlice';
import KeyService from '../../services/KeyService';

interface HeaderInfo {
  hash: string; // display (big-endian) hex
  prev_hash: string;
  time: number;
  bits: number;
}

// [txid(display hex), vout, value(sats), pubkey-hash bytes]
type ScanOwned = [string, number, number, number[]];
// [prev txid(display hex), prev vout]
type ScanSpent = [string, number];

interface ScanResult {
  scanned_blocks: number;
  owned: ScanOwned[];
  spent: ScanSpent[];
}

export interface NodeUtxo {
  txid: string;
  vout: number;
  value: number;
  address: string;
}

export interface NodeSyncResult {
  /** Unspent outputs the wallet owns, grouped by address. */
  byAddress: Map<string, NodeUtxo[]>;
  /** Total confirmed value across all watched addresses (sats). */
  totalSats: number;
  /** Block hash the header walk ended on (the node's tip we saw). */
  tipHash: string | null;
  scannedBlocks: number;
  watchedAddresses: number;
}

/** A node returns up to this many headers per `headers` message. */
const HEADERS_PER_BATCH = 2000;
/** Safety bound on the header walk (2000 * 500 = 1M blocks). */
const MAX_HEADER_BATCHES = 500;
/**
 * How many of the most recent blocks to bloom-scan. Each block costs one
 * merkleblock round-trip, so a full-history scan is impractical without the
 * wallet's birth height (Flowee Pay solves this with checkpoints + birth
 * height). Until birth-height tracking lands, scan a recent window — which
 * covers a freshly created/funded wallet.
 */
const DEFAULT_SCAN_WINDOW = 500;

const toHex = (bytes: Uint8Array | number[]): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

const netLabel = (network: Network): string =>
  network === Network.CHIPNET ? 'chipnet' : 'mainnet';

/** The wallet's watched pubkey-hashes (hash160) + a hash -> address map. */
async function watchedHashes(
  walletId: number
): Promise<{ hashes: string[]; hashToAddress: Map<string, string> }> {
  const keys = await KeyService.retrieveKeys(walletId);
  const hashToAddress = new Map<string, string>();
  const hashes: string[] = [];
  for (const k of keys) {
    const h = toHex(k.pubkeyHash);
    if (h.length === 40 && !hashToAddress.has(h)) {
      hashes.push(h);
      hashToAddress.set(h, k.address);
    }
  }
  return { hashes, hashToAddress };
}

/** Walk headers from `fromHash` (or genesis) to the node's tip. */
async function syncHeaders(
  host: string,
  port: number,
  network: Network,
  fromHash?: string
): Promise<string[]> {
  const blockHashes: string[] = [];
  let locator = fromHash ?? null;
  for (let i = 0; i < MAX_HEADER_BATCHES; i++) {
    const headers = await invoke<HeaderInfo[]>('bip37_headers', {
      host,
      port,
      network: netLabel(network),
      locator,
    });
    if (headers.length === 0) break;
    for (const h of headers) blockHashes.push(h.hash);
    locator = headers[headers.length - 1].hash;
    if (headers.length < HEADERS_PER_BATCH) break; // reached the tip
  }
  return blockHashes;
}

/**
 * Sync the wallet against a node: header-walk to the tip, bloom-scan the most
 * recent `scanWindow` blocks, and build the address -> UTXO index (owned outputs
 * minus anything already spent).
 */
export async function nodeSync(
  host: string,
  port: number,
  network: Network,
  walletId: number,
  opts?: { fromHash?: string; scanWindow?: number }
): Promise<NodeSyncResult> {
  const { hashes, hashToAddress } = await watchedHashes(walletId);
  if (hashes.length === 0) {
    return { byAddress: new Map(), totalSats: 0, tipHash: null, scannedBlocks: 0, watchedAddresses: 0 };
  }

  const allBlocks = await syncHeaders(host, port, network, opts?.fromHash);
  const window = opts?.scanWindow ?? DEFAULT_SCAN_WINDOW;
  const blockHashes = allBlocks.slice(-window);

  const res = await invoke<ScanResult>('bip37_scan', {
    host,
    port,
    network: netLabel(network),
    pubkeyHashes: hashes,
    blockHashes,
  });

  // Owned outputs minus those already consumed by a scanned input.
  const spent = new Set(res.spent.map(([txid, vout]) => `${txid}:${vout}`));
  const byAddress = new Map<string, NodeUtxo[]>();
  let totalSats = 0;
  for (const [txid, vout, value, pkh] of res.owned) {
    if (spent.has(`${txid}:${vout}`)) continue;
    const address = hashToAddress.get(toHex(pkh));
    if (!address) continue; // bloom false positive for a hash we don't own
    const list = byAddress.get(address) ?? [];
    list.push({ txid, vout, value, address });
    byAddress.set(address, list);
    totalSats += value;
  }

  return {
    byAddress,
    totalSats,
    tipHash: allBlocks.length ? allBlocks[allBlocks.length - 1] : null,
    scannedBlocks: res.scanned_blocks,
    watchedAddresses: hashes.length,
  };
}

/** Broadcast a signed raw transaction through the node (P2P). Returns the txid. */
export async function nodeBroadcast(
  host: string,
  port: number,
  network: Network,
  txHex: string
): Promise<string> {
  return invoke<string>('bip37_broadcast', {
    host,
    port,
    network: netLabel(network),
    txHex,
  });
}
