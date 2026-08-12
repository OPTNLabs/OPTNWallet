import KeyService from './KeyService';
import { logError } from '../utils/errorHandling';
import { Network } from '../state/slices/networkSlice';
import { deriveBchAddressFromHdPublicKey } from './HdWalletService';
import {
  getLocalStorage,
  readStorageItem,
  writeStorageItem,
} from '../utils/browserStorage';

const ADDRESS_BATCH_SIZE = 10;
const MAX_BATCHES_PER_PASS = 8;
const GAP_LIMIT_BATCHES = 3;
const DISCOVERY_COOLDOWN_MS = 30_000;
const STORAGE_KEY = 'optn_wallet_discovery_state_v1';

type DiscoveryState = {
  nextBatchStart: number;
  consecutiveUnusedBatches: number;
  lastDiscoveredAt: number;
  knownKeyCount?: number;
  highestKnownIndex?: number;
};

type WalletDiscoveryState = Record<string, DiscoveryState>;

type WalletBatchUsageChecker = (
  walletId: number,
  batch: { address: string; addressIndex: number; changeIndex: number }[]
) => Promise<string[]>;

const inFlightByWallet = new Map<number, Promise<string[]>>();

function stateKey(walletId: number): string {
  return String(walletId);
}

function readState(): WalletDiscoveryState {
  try {
    const raw = readStorageItem(getLocalStorage(), STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as WalletDiscoveryState;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeState(state: WalletDiscoveryState): void {
  try {
    writeStorageItem(getLocalStorage(), STORAGE_KEY, JSON.stringify(state));
  } catch {
    // best effort
  }
}

function getBatchStart(index: number): number {
  return Math.floor(index / ADDRESS_BATCH_SIZE) * ADDRESS_BATCH_SIZE;
}

function keyInventory(keys: Array<{ addressIndex: number }>): {
  knownKeyCount: number;
  highestKnownIndex: number;
} {
  return {
    knownKeyCount: keys.length,
    highestKnownIndex: keys.reduce(
      (max, key) =>
        Number.isFinite(key.addressIndex) && key.addressIndex > max
          ? key.addressIndex
          : max,
      -1
    ),
  };
}

async function getCandidateBatch(
  walletId: number,
  network: Network,
  accountIndex: number,
  startIndex: number
): Promise<{ address: string; addressIndex: number; changeIndex: number }[]> {
  const xpubs = await KeyService.getWalletXpubs(walletId, accountIndex);
  const batch: {
    address: string;
    addressIndex: number;
    changeIndex: number;
  }[] = [];

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
): Promise<string[]> {
  const keys = await KeyService.retrieveKeys(walletId);
  const knownAddresses = new Set(keys.map((key) => key.address));
  const recoveredAddresses: string[] = [];
  const state = readState();
  const { highestKnownIndex } = keyInventory(keys);
  // The cursor is only a cooldown/status hint. Always restart from the highest
  // key that is actually persisted: another wallet window may have overwritten
  // a newer key row while leaving this window's old discovery cursor ahead.
  const nextBatchStart =
    highestKnownIndex >= 0 ? getBatchStart(highestKnownIndex) : 0;
  let batchStart = nextBatchStart;
  let consecutiveUnusedBatches = 0;
  let batchesProcessed = 0;

  while (batchesProcessed < MAX_BATCHES_PER_PASS) {
    const batch = await getCandidateBatch(walletId, network, 0, batchStart);
    if (batch.length === 0) {
      break;
    }

    const usedAddresses = await batchHasUsage(walletId, batch);
    const used = new Set(usedAddresses);
    batchesProcessed += 1;
    batchStart += ADDRESS_BATCH_SIZE;

    if (used.size > 0) {
      for (const candidate of batch) {
        if (
          !used.has(candidate.address) ||
          knownAddresses.has(candidate.address)
        ) {
          continue;
        }
        await KeyService.createKeys(
          walletId,
          0,
          candidate.changeIndex,
          candidate.addressIndex
        );
        knownAddresses.add(candidate.address);
        recoveredAddresses.push(candidate.address);
      }
      consecutiveUnusedBatches = 0;
      continue;
    }

    consecutiveUnusedBatches += 1;
    if (consecutiveUnusedBatches >= GAP_LIMIT_BATCHES) {
      break;
    }
  }

  const persistedInventory = keyInventory(
    recoveredAddresses.length > 0
      ? await KeyService.retrieveKeys(walletId)
      : keys
  );
  state[stateKey(walletId)] = {
    nextBatchStart: batchStart,
    consecutiveUnusedBatches,
    lastDiscoveredAt: Date.now(),
    ...persistedInventory,
  };
  writeState(state);
  return recoveredAddresses;
}

const WalletDiscoveryService = {
  async ensureInitialAddressBatches(
    walletId: number,
    network: Network,
    batchHasUsage: WalletBatchUsageChecker
  ): Promise<string[]> {
    const inflight = inFlightByWallet.get(walletId);
    if (inflight) {
      return await inflight;
    }

    const state = readState()[stateKey(walletId)];
    if (state && Date.now() - state.lastDiscoveredAt < DISCOVERY_COOLDOWN_MS) {
      const currentInventory = keyInventory(
        await KeyService.retrieveKeys(walletId)
      );
      if (
        state.knownKeyCount === currentInventory.knownKeyCount &&
        state.highestKnownIndex === currentInventory.highestKnownIndex
      ) {
        return [];
      }
    }

    const run = expandDiscovery(walletId, network, batchHasUsage).catch(
      (error): string[] => {
        logError('WalletDiscoveryService.ensureInitialAddressBatches', error, {
          walletId,
        });
        return [];
      }
    );

    inFlightByWallet.set(walletId, run);
    try {
      return await run;
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
