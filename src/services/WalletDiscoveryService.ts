import KeyService from './KeyService';
import { logError } from '../utils/errorHandling';
import { Network } from '../state/slices/networkSlice';
import {
  BCH_STANDARD_BRANCH_INDEX,
  BCH_WALLET_SCAN_BRANCH_NAMES,
  type BchStandardBranchName,
  deriveBchAddressFromHdPublicKey,
} from './HdWalletService';
import {
  getLocalStorage,
  readStorageItem,
  writeStorageItem,
} from '../utils/browserStorage';
import { isDesktopPlatform } from '../utils/platform';

// BIP44's gap limit is measured in address indexes. Keep the network request
// at that same size while checking the wallet branches selected for the
// current transport.
const ADDRESS_BATCH_SIZE = 20;
const MAX_BATCHES_PER_PASS = 4;
// CashFusion reserves fresh receive indexes before a round is known to have
// succeeded. A failed round therefore leaves an unused gap that is not present
// in ordinary BIP44 usage. Keep discovery bounded, but allow enough empty
// receive windows to recover a wallet that was fused on another device.
const MAX_EMPTY_BATCHES = 64;
const DISCOVERY_COOLDOWN_MS = 30_000;
const STORAGE_KEY = 'optn_wallet_discovery_state_v1';

const DISCOVERY_BRANCHES = BCH_WALLET_SCAN_BRANCH_NAMES.map((name) => ({
  name,
  branchIndex: BCH_STANDARD_BRANCH_INDEX[name],
}));
const PRIMARY_WALLET_BRANCHES = ['receive', 'change'] as const;

function getDiscoveryBranches(): ReadonlyArray<{
  name: BchStandardBranchName;
  branchIndex: number;
}> {
  // Desktop uses a raw Electrum TCP connection and can send the full batch
  // shape. Web/Capacitor uses WSS and sends individual JSON-RPC frames, so the
  // initial mobile restore only scans the standard wallet branches. CashFusion
  // is desktop-only until its mobile transport is available.
  return isDesktopPlatform()
    ? DISCOVERY_BRANCHES
    : PRIMARY_WALLET_BRANCHES.map((name) => ({
        name,
        branchIndex: BCH_STANDARD_BRANCH_INDEX[name],
      }));
}

export type WalletDerivedAddressCandidate = {
  address: string;
  tokenAddress: string;
  addressIndex: number;
  changeIndex: number;
  branchName: BchStandardBranchName;
};

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
  xpubs: Awaited<ReturnType<typeof KeyService.getWalletXpubs>>,
  branches: ReadonlyArray<{
    name: BchStandardBranchName;
    branchIndex: number;
  }>
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
    for (const branch of branches) {
      const xpub = xpubs[branch.name];
      if (!xpub) continue;

      const derived = deriveBchAddressFromHdPublicKey(
        network,
        xpub,
        BigInt(addressIndex)
      );
      if (!derived) continue;

      // Preserve the existing receive-to-change bootstrap, while also
      // probing the branch-specific DeFi/Cauldron addresses.
      const pairedChangeAddress =
        branch.name === 'receive' && xpubs.change
          ? deriveBchAddressFromHdPublicKey(
              network,
              xpubs.change,
              BigInt(addressIndex)
            )?.address ?? null
          : null;

      batch.push({
        address: derived.address,
        addressIndex,
        changeIndex: branch.branchIndex,
        pairedChangeAddress,
      });
    }
  }

  return batch;
}

/**
 * Derive the same ordinary BCH branches used by wallet discovery without
 * touching the database. Cauldron activity uses this read-only inventory too,
 * so desktop and mobile cannot drift into different branch coverage.
 */
export async function deriveWalletAddressCandidates(
  walletId: number,
  network: Network,
  options: {
    startIndex?: number;
    count?: number;
    accountNumber?: number;
    branchNames?: readonly BchStandardBranchName[];
  } = {}
): Promise<WalletDerivedAddressCandidate[]> {
  const startIndex = options.startIndex ?? 0;
  const count = options.count ?? ADDRESS_BATCH_SIZE;
  if (
    !Number.isSafeInteger(startIndex) ||
    startIndex < 0 ||
    !Number.isSafeInteger(count) ||
    count < 1
  ) {
    throw new Error('Wallet address scan range is invalid.');
  }

  const xpubs = await KeyService.getWalletXpubs(
    walletId,
    options.accountNumber ?? 0
  );
  const branches = options.branchNames ?? BCH_WALLET_SCAN_BRANCH_NAMES;
  const candidates: WalletDerivedAddressCandidate[] = [];

  for (let offset = 0; offset < count; offset += 1) {
    const addressIndex = startIndex + offset;
    for (const branchName of branches) {
      const xpub = xpubs[branchName];
      if (!xpub) continue;
      const derived = deriveBchAddressFromHdPublicKey(
        network,
        xpub,
        BigInt(addressIndex)
      );
      if (!derived) continue;
      candidates.push({
        address: derived.address,
        tokenAddress: derived.tokenAddress,
        addressIndex,
        changeIndex: BCH_STANDARD_BRANCH_INDEX[branchName],
        branchName,
      });
    }
  }

  return candidates;
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
  const inventory = keyInventory(keys);
  const initialHighestKnownIndex = inventory.highestKnownIndex;
  const savedState = state[stateKey(walletId)];
  const stateMatchesInventory =
    savedState?.knownKeyCount === inventory.knownKeyCount &&
    savedState.highestKnownIndex === inventory.highestKnownIndex;
  const firstBatchStart =
    inventory.highestKnownIndex >= 0
      ? getBatchStart(inventory.highestKnownIndex)
      : 0;
  const savedBatchStart =
    stateMatchesInventory &&
    typeof savedState?.nextBatchStart === 'number' &&
    Number.isSafeInteger(savedState.nextBatchStart) &&
    savedState.nextBatchStart >= 0
      ? getBatchStart(savedState.nextBatchStart)
      : firstBatchStart;
  // Keep the forward cursor after an empty batch. Restarting at the highest
  // persisted key makes a cross-device restore stop forever at the first
  // CashFusion gap, because unused/reserved indexes are intentionally not
  // persisted on the restoring device.
  const nextBatchStart = Math.max(firstBatchStart, savedBatchStart);
  let batchStart = nextBatchStart;
  let consecutiveUnusedBatches =
    stateMatchesInventory &&
    typeof savedState?.consecutiveUnusedBatches === 'number' &&
    Number.isSafeInteger(savedState.consecutiveUnusedBatches) &&
    savedState.consecutiveUnusedBatches >= 0
      ? savedState.consecutiveUnusedBatches
      : 0;
  let batchesProcessed = 0;
  const branches = getDiscoveryBranches();

  while (
    batchesProcessed < MAX_BATCHES_PER_PASS &&
    consecutiveUnusedBatches < MAX_EMPTY_BATCHES
  ) {
    const batch = await getCandidateBatch(network, batchStart, xpubs, branches);
    if (batch.length === 0) {
      break;
    }

    const usedAddresses = await batchHasUsage(walletId, batch);
    const used = new Set(usedAddresses);
    batchesProcessed += 1;
    batchStart += ADDRESS_BATCH_SIZE;
    if (import.meta.env.DEV) {
      console.info('[WalletDiscovery] history window', {
        walletId,
        transport: isDesktopPlatform() ? 'desktop-tcp' : 'mobile-wss',
        startIndex: batchStart - ADDRESS_BATCH_SIZE,
        candidateCount: batch.length,
        usedCount: used.size,
      });
    }

    if (used.size > 0) {
      let recoveredInBatch = false;
      for (const candidate of batch) {
        if (!used.has(candidate.address)) {
          continue;
        }

        if (!knownAddresses.has(candidate.address)) {
          await KeyService.createKeys(
            walletId,
            0,
            candidate.changeIndex,
            candidate.addressIndex
          );
          knownAddresses.add(candidate.address);
          recoveredAddresses.push(candidate.address);
          recoveredInBatch =
            recoveredInBatch ||
            candidate.addressIndex > initialHighestKnownIndex;
        }

        if (
          candidate.pairedChangeAddress &&
          !knownAddresses.has(candidate.pairedChangeAddress)
        ) {
          await KeyService.createKeys(walletId, 0, 1, candidate.addressIndex);
          knownAddresses.add(candidate.pairedChangeAddress);
          recoveredAddresses.push(candidate.pairedChangeAddress);
          recoveredInBatch =
            recoveredInBatch ||
            candidate.addressIndex > initialHighestKnownIndex;
        }
      }
      consecutiveUnusedBatches = 0;
      // Query recovered addresses as soon as their first used window is
      // materialized. Continuing through later windows before returning made a
      // funded imported wallet appear empty for the entire discovery pass.
      if (recoveredInBatch) break;
      continue;
    }

    consecutiveUnusedBatches += 1;
    // Do not stop at the first empty window. CashFusion can leave reserved,
    // never-used indexes between successful rounds. The hard ceiling above
    // prevents an unbounded scan of an otherwise unused account.
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
