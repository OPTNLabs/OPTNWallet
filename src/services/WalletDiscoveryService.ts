import KeyService from './KeyService';
import { logError } from '../utils/errorHandling';
import { Network } from '../state/slices/networkSlice';
import { deriveBchAddressFromHdPublicKey } from './HdWalletService';
import {
  getLocalStorage,
  readStorageItem,
  writeStorageItem,
} from '../utils/browserStorage';

// BIP44's gap limit is measured on the external/receive chain. Keep the
// network request at that same size so one discovery batch can prove a full
// gap without probing change addresses as well.
const ADDRESS_BATCH_SIZE = 20;
const MAX_BATCHES_PER_PASS = 4;
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
  network: Network,
  startIndex: number,
  xpubs: Awaited<ReturnType<typeof KeyService.getWalletXpubs>>
): Promise<
  {
    address: string;
    addressIndex: number;
    changeIndex: number;
    pairedChangeAddress: string | null;
  }[]
> {
  const batch: {
    address: string;
    addressIndex: number;
    changeIndex: number;
    pairedChangeAddress: string | null;
  }[] = [];

  for (let offset = 0; offset < ADDRESS_BATCH_SIZE; offset += 1) {
    const addressIndex = startIndex + offset;
    const receive = deriveBchAddressFromHdPublicKey(
      network,
      xpubs.receive,
      BigInt(addressIndex)
    );
    if (!receive) continue;

    // Change is materialized only when its paired receive index is used. It
    // remains part of the local key inventory, but is deliberately excluded
    // from account-discovery RPCs: BIP44 discovers accounts from external
    // chain history and treats change as an internal chain.
    const change = deriveBchAddressFromHdPublicKey(
      network,
      xpubs.change,
      BigInt(addressIndex)
    );
    batch.push({
      address: receive.address,
      addressIndex,
      changeIndex: 0,
      pairedChangeAddress: change?.address ?? null,
    });
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
  const xpubs = await KeyService.getWalletXpubs(walletId, 0);
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
    const batch = await getCandidateBatch(
      network,
      batchStart,
      xpubs
    );
    if (batch.length === 0) {
      break;
    }

    const usedAddresses = await batchHasUsage(walletId, batch);
    const used = new Set(usedAddresses);
    batchesProcessed += 1;
    batchStart += ADDRESS_BATCH_SIZE;

    if (used.size > 0) {
      for (const candidate of batch) {
        if (!used.has(candidate.address)) {
          continue;
        }

        if (!knownAddresses.has(candidate.address)) {
          await KeyService.createKeys(walletId, 0, 0, candidate.addressIndex);
          knownAddresses.add(candidate.address);
          recoveredAddresses.push(candidate.address);
        }

        if (
          candidate.pairedChangeAddress &&
          !knownAddresses.has(candidate.pairedChangeAddress)
        ) {
          await KeyService.createKeys(walletId, 0, 1, candidate.addressIndex);
          knownAddresses.add(candidate.pairedChangeAddress);
          recoveredAddresses.push(candidate.pairedChangeAddress);
        }
      }
      consecutiveUnusedBatches = 0;
      continue;
    }

    consecutiveUnusedBatches += 1;
    // ADDRESS_BATCH_SIZE is the BIP44 gap limit. One completely unused
    // external batch is enough to stop account discovery.
    break;
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

  async waitForIdle(walletId: number): Promise<void> {
    const inflight = inFlightByWallet.get(walletId);
    if (!inflight) return;
    await inflight.catch(() => undefined);
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
