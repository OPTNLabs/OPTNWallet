import KeyService from './KeyService';
import { logError } from '../utils/errorHandling';
import { Network } from '../redux/networkSlice';
import { deriveBchAddressFromHdPublicKey } from './HdWalletService';

const ADDRESS_BATCH_SIZE = 10;
const MAX_BATCHES_PER_PASS = 3;
const GAP_LIMIT_BATCHES = 1;
const DISCOVERY_COOLDOWN_MS = 30_000;
const STORAGE_KEY = 'optn_wallet_discovery_state_v1';

type DiscoveryState = {
  nextBatchStart: number;
  consecutiveUnusedBatches: number;
  lastDiscoveredAt: number;
};

type WalletDiscoveryState = Record<string, DiscoveryState>;

type WalletBatchUsageChecker = (
  walletId: number,
  batch: { address: string; addressIndex: number; changeIndex: number }[]
) => Promise<boolean>;

const inFlightByWallet = new Map<number, Promise<void>>();

function stateKey(walletId: number): string {
  return String(walletId);
}

function readState(): WalletDiscoveryState {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as WalletDiscoveryState;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeState(state: WalletDiscoveryState): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // best effort
  }
}

function getBatchStart(index: number): number {
  return Math.floor(index / ADDRESS_BATCH_SIZE) * ADDRESS_BATCH_SIZE;
}

async function getCandidateBatch(
  walletId: number,
  network: Network,
  accountIndex: number,
  startIndex: number
): Promise<{ address: string; addressIndex: number; changeIndex: number }[]> {
  const xpubs = await KeyService.getWalletXpubs(walletId, accountIndex);
  const batch: { address: string; addressIndex: number; changeIndex: number }[] = [];

  for (let offset = 0; offset < ADDRESS_BATCH_SIZE; offset += 1) {
    const addressIndex = startIndex + offset;
    for (const [changeIndex, branchName] of [
      [0, 'receive'],
      [1, 'change'],
    ] as const) {
      const xpub = xpubs[branchName];
      const derived = deriveBchAddressFromHdPublicKey(
        network,
        xpub,
        BigInt(addressIndex)
      );
      if (!derived) continue;
      batch.push({
        address: derived.address,
        addressIndex,
        changeIndex,
      });
    }
  }

  return batch;
}

async function expandDiscovery(
  walletId: number,
  network: Network,
  batchHasUsage: WalletBatchUsageChecker
): Promise<void> {
  const keys = await KeyService.retrieveKeys(walletId);
  const state = readState();
  const walletState = state[stateKey(walletId)];
  const highestKnownIndex = keys.reduce(
    (max, key) =>
      Number.isFinite(key.addressIndex) && key.addressIndex > max
        ? key.addressIndex
        : max,
    -1
  );
  const nextBatchStart =
    walletState?.nextBatchStart ??
    (highestKnownIndex >= 0 ? getBatchStart(highestKnownIndex) : 0);
  let batchStart = nextBatchStart;
  let consecutiveUnusedBatches = walletState?.consecutiveUnusedBatches ?? 0;
  let batchesProcessed = 0;

  while (batchesProcessed < MAX_BATCHES_PER_PASS) {
    const batch = await getCandidateBatch(walletId, network, 0, batchStart);
    if (batch.length === 0) {
      break;
    }

    const used = await batchHasUsage(walletId, batch);
    batchesProcessed += 1;
    batchStart += ADDRESS_BATCH_SIZE;

    if (used) {
      consecutiveUnusedBatches = 0;
      continue;
    }

    consecutiveUnusedBatches += 1;
    if (consecutiveUnusedBatches >= GAP_LIMIT_BATCHES) {
      break;
    }
  }

  state[stateKey(walletId)] = {
    nextBatchStart: batchStart,
    consecutiveUnusedBatches,
    lastDiscoveredAt: Date.now(),
  };
  writeState(state);
}

const WalletDiscoveryService = {
  async ensureInitialAddressBatches(
    walletId: number,
    network: Network,
    batchHasUsage: WalletBatchUsageChecker
  ): Promise<void> {
    const inflight = inFlightByWallet.get(walletId);
    if (inflight) {
      await inflight;
      return;
    }

    const state = readState()[stateKey(walletId)];
    if (state && Date.now() - state.lastDiscoveredAt < DISCOVERY_COOLDOWN_MS) {
      return;
    }

    const run = expandDiscovery(walletId, network, batchHasUsage).catch((error) => {
      logError('WalletDiscoveryService.ensureInitialAddressBatches', error, { walletId });
    });

    inFlightByWallet.set(walletId, run);
    try {
      await run;
    } finally {
      inFlightByWallet.delete(walletId);
    }
  },

  clear(walletId?: number): void {
    const state = readState();
    if (typeof walletId === 'number') {
      delete state[stateKey(walletId)];
    } else {
      for (const key of Object.keys(state)) {
        delete state[key];
      }
    }
    writeState(state);
  },
};

export default WalletDiscoveryService;
