import { binToHex, hexToBin, lockingBytecodeToCashAddress } from '@bitauth/libauth';
import type { Network } from '../../../state/slices/networkSlice';
import type { UTXO } from '../../../types/types';
import { derivePublicKeyHash } from '../../../utils/derivePublicKeyHash';
import { parseSatoshis } from '../../../utils/binary';
import { shortenHash } from '../../../utils/shortenHash';
import {
  getCauldronPoolV0WithdrawPublicKeyHash,
  type CauldronPool,
  type CauldronPoolHistoryResponse,
  type CauldronPoolTrade,
  type CauldronWalletPoolPosition,
  type NormalizedCauldronToken,
  planAggregatedTradeForTargetSupply,
  collectWalletCreatedCauldronPoolCandidates,
  fetchNormalizedCauldronPools,
  tryParseCauldronPoolFromUtxo,
} from '../../../services/cauldron';
import type { CauldronApiClient } from '../../../services/cauldron/api';
import OutboundTransactionTracker from '../../../services/OutboundTransactionTracker';

export function shortTokenId(tokenId: string): string {
  return shortenHash(tokenId, 4, 4);
}

export function dedupePoolsBySelectionId(pools: CauldronPool[]): CauldronPool[] {
  const byId = new Map<string, CauldronPool>();
  for (const pool of pools) byId.set(getPoolSelectionId(pool), pool);
  return [...byId.values()];
}

export function dedupeWalletPoolPositions(
  positions: CauldronWalletPoolPosition[]
): CauldronWalletPoolPosition[] {
  const byId = new Map<string, CauldronWalletPoolPosition>();
  for (const position of positions) byId.set(getPoolSelectionId(position.pool), position);
  return [...byId.values()];
}

export function getWalletPoolDisplayKey(
  position: CauldronWalletPoolPosition
): string {
  return (
    position.pool.output.tokenCategory.trim().toLowerCase() ||
    position.historyPoolId?.trim().toLowerCase() ||
    getPoolSelectionId(position.pool)
  );
}

export function dedupeWalletPoolPositionsForDisplay(
  positions: CauldronWalletPoolPosition[]
): CauldronWalletPoolPosition[] {
  const byId = new Map<string, CauldronWalletPoolPosition>();
  for (const position of positions) {
    const key = getWalletPoolDisplayKey(position);
    if (!byId.has(key)) byId.set(key, position);
  }
  return [...byId.values()];
}

export type PersistedPendingWalletPoolPosition = {
  pool: CauldronPool;
  ownerAddress: string | null;
  historyPoolId?: string | null;
  detectionSource: CauldronWalletPoolPosition['detectionSource'];
};

type PersistedBigIntValue = { __bigint__: string };

function isPersistedBigIntValue(value: unknown): value is PersistedBigIntValue {
  return Boolean(
    value &&
      typeof value === 'object' &&
      '__bigint__' in value &&
      typeof (value as PersistedBigIntValue).__bigint__ === 'string'
  );
}

export function serializeForStorage(value: unknown): string {
  return JSON.stringify(value, (_key, nextValue) =>
    typeof nextValue === 'bigint' ? { __bigint__: nextValue.toString() } : nextValue
  );
}

export function deserializeFromStorage<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw, (_key, nextValue) => {
      if (isPersistedBigIntValue(nextValue)) return BigInt(nextValue.__bigint__);
      return nextValue;
    }) as T;
  } catch {
    return null;
  }
}

export const PENDING_WALLET_POOLS_STORAGE_PREFIX = 'optn.cauldron.pending-wallet-pools';
export const WALLET_POOLS_STORAGE_PREFIX = 'optn.cauldron.wallet-pools';
export const CREATED_WALLET_POOLS_STORAGE_PREFIX = 'optn.cauldron.created-wallet-pools';
export const CREATED_WALLET_POOL_TOKENS_STORAGE_PREFIX = 'optn.cauldron.created-wallet-pool-tokens';
export const CREATED_WALLET_POOL_LOCKING_BYTECODES_STORAGE_PREFIX =
  'optn.cauldron.created-wallet-pool-locking-bytecodes';

function appendWalletScope(network: string, walletId?: number | string): string {
  return walletId === undefined || walletId === null
    ? network
    : `${network}:${walletId}`;
}

export function getPendingWalletPoolsStorageKey(
  network: string,
  walletId?: number | string
): string {
  return `${PENDING_WALLET_POOLS_STORAGE_PREFIX}:${appendWalletScope(
    network,
    walletId
  )}`;
}
export function getWalletPoolsStorageKey(
  network: string,
  walletId?: number | string
): string {
  return `${WALLET_POOLS_STORAGE_PREFIX}:${appendWalletScope(
    network,
    walletId
  )}`;
}
export function getCreatedWalletPoolsStorageKey(
  network: string,
  walletId?: number | string
): string {
  return `${CREATED_WALLET_POOLS_STORAGE_PREFIX}:${appendWalletScope(
    network,
    walletId
  )}`;
}
export function getCreatedWalletPoolTokensStorageKey(
  network: string,
  walletId?: number | string
): string {
  return `${CREATED_WALLET_POOL_TOKENS_STORAGE_PREFIX}:${appendWalletScope(
    network,
    walletId
  )}`;
}
export function getCreatedWalletPoolLockingBytecodesStorageKey(
  network: string,
  walletId?: number | string
): string {
  return `${CREATED_WALLET_POOL_LOCKING_BYTECODES_STORAGE_PREFIX}:${appendWalletScope(
    network,
    walletId
  )}`;
}

export function getCauldronPoolStorage(): Storage | null {
  return globalThis.localStorage ?? globalThis.sessionStorage ?? null;
}
export function getCauldronPoolStorageItem(key: string): string | null {
  return getCauldronPoolStorage()?.getItem(key) ?? null;
}
export function setCauldronPoolStorageItem(key: string, value: string): void {
  getCauldronPoolStorage()?.setItem(key, value);
}
export function removeCauldronPoolStorageItem(key: string): void {
  getCauldronPoolStorage()?.removeItem(key);
}

export function resolveCauldronPoolWithdrawPublicKeyHash(
  pool: Pick<CauldronPool, 'output' | 'parameters'>
): Uint8Array {
  const direct = ensureUint8Array(pool.parameters.withdrawPublicKeyHash);
  if (direct.length === 20) return direct;
  const recovered = getCauldronPoolV0WithdrawPublicKeyHash(ensureUint8Array(pool.output.lockingBytecode));
  return recovered?.length === 20 ? recovered : direct;
}

function ensureUint8Array(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return new Uint8Array(value);
  if (typeof value === 'string' && value) return hexToBin(value);
  return new Uint8Array();
}

export function logCauldronTxPlan(stage: string, payload: Record<string, unknown>): void {
  if (!import.meta.env.DEV) return;
  console.debug(`[Cauldron:TX] ${stage}`, payload);
}
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown error';
}

export function serializePendingWalletPoolPositions(
  positions: CauldronWalletPoolPosition[]
): PersistedPendingWalletPoolPosition[] {
  return positions.map((position) => ({
    pool: position.pool,
    ownerAddress: position.ownerAddress ?? null,
    historyPoolId: position.historyPoolId ?? null,
    detectionSource: position.detectionSource,
  }));
}

export function deserializePendingWalletPoolPositions(raw: string | null): CauldronWalletPoolPosition[] {
  const parsed = deserializeFromStorage<unknown>(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const candidate = entry as PersistedPendingWalletPoolPosition;
    if (!candidate.pool?.output || !candidate.pool?.parameters) return [];
    const withdrawPublicKeyHash = resolveCauldronPoolWithdrawPublicKeyHash({
      output: candidate.pool.output,
      parameters: candidate.pool.parameters,
    });
    return [
      {
        pool: {
          ...candidate.pool,
          parameters: { withdrawPublicKeyHash },
          output: { ...candidate.pool.output, lockingBytecode: ensureUint8Array(candidate.pool.output.lockingBytecode) },
        },
        ownerAddress: typeof candidate.ownerAddress === 'string' ? candidate.ownerAddress : null,
        historyPoolId: typeof candidate.historyPoolId === 'string' ? candidate.historyPoolId : null,
        matchingNftUtxos: [],
        hasMatchingTokenNft: false,
        detectionSource: candidate.detectionSource ?? 'owner_pkh',
      },
    ];
  });
}

export const serializeWalletPoolPositions = serializePendingWalletPoolPositions;
export const deserializeWalletPoolPositions = deserializePendingWalletPoolPositions;

export function loadCreatedWalletPoolPositions(
  network: string,
  walletId?: number | string
): CauldronWalletPoolPosition[] {
  return dedupeWalletPoolPositions(
    deserializeWalletPoolPositions(
      getCauldronPoolStorageItem(
        getCreatedWalletPoolsStorageKey(network, walletId)
      )
    )
  );
}

export function loadWalletPoolPositionsFromStorage(
  network: string,
  walletId?: number | string
): CauldronWalletPoolPosition[] {
  return dedupeWalletPoolPositions(
    deserializeWalletPoolPositions(
      getCauldronPoolStorageItem(getWalletPoolsStorageKey(network, walletId))
    )
  );
}

export function loadCreatedWalletPoolTokenCategories(
  network: string,
  walletId?: number | string
): string[] {
  const raw = deserializeFromStorage<unknown>(
    getCauldronPoolStorageItem(
      getCreatedWalletPoolTokensStorageKey(network, walletId)
    )
  );
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map((tokenId) => (typeof tokenId === 'string' ? tokenId.toLowerCase() : '')).filter(Boolean))];
}

export function buildCreatedPoolParametersByLockingBytecode(
  pools: Array<CauldronPool | CauldronWalletPoolPosition>
): Map<string, Uint8Array> {
  const byBytecode = new Map<string, Uint8Array>();
  for (const entry of pools) {
    const pool = 'pool' in entry ? entry.pool : entry;
    byBytecode.set(binToHex(pool.output.lockingBytecode).toLowerCase(), pool.parameters.withdrawPublicKeyHash);
  }
  return byBytecode;
}

export function collectPoolTokenCategories(
  entries: Array<CauldronPool | CauldronWalletPoolPosition>
): string[] {
  return [...new Set(entries.map((entry) => ('pool' in entry ? entry.pool.output.tokenCategory : entry.output.tokenCategory)).map((tokenId) => tokenId?.toLowerCase()).filter(Boolean))];
}

export function persistCreatedWalletPoolPositions(
  network: string,
  positions: CauldronWalletPoolPosition[],
  walletId?: number | string
): void {
  const storageKey = getCreatedWalletPoolsStorageKey(network, walletId);
  if (positions.length === 0) return removeCauldronPoolStorageItem(storageKey);
  setCauldronPoolStorageItem(storageKey, serializeForStorage(serializeWalletPoolPositions(positions)));
}

export function loadCreatedWalletPoolLockingBytecodes(
  network: string,
  walletId?: number | string
): Uint8Array[] {
  const raw = deserializeFromStorage<unknown>(
    getCauldronPoolStorageItem(
      getCreatedWalletPoolLockingBytecodesStorageKey(network, walletId)
    )
  );
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map((value) => (typeof value === 'string' ? value.toLowerCase().trim() : '')).filter(Boolean))].flatMap((hex) => {
    try {
      return [hexToBin(hex)];
    } catch {
      return [];
    }
  });
}

export function persistCreatedWalletPoolTokenCategories(
  network: string,
  tokenIds: string[],
  walletId?: number | string
): void {
  const storageKey = getCreatedWalletPoolTokensStorageKey(network, walletId);
  const normalized = [...new Set(tokenIds.map((tokenId) => tokenId.toLowerCase()))];
  if (normalized.length === 0) return removeCauldronPoolStorageItem(storageKey);
  setCauldronPoolStorageItem(storageKey, serializeForStorage(normalized));
}

export function persistCreatedWalletPoolLockingBytecodes(
  network: string,
  lockingBytecodes: Uint8Array[],
  walletId?: number | string
): void {
  const storageKey = getCreatedWalletPoolLockingBytecodesStorageKey(network, walletId);
  const normalized = [...new Set(lockingBytecodes.map((bytecode) => binToHex(bytecode).toLowerCase()))];
  if (normalized.length === 0) return removeCauldronPoolStorageItem(storageKey);
  setCauldronPoolStorageItem(storageKey, serializeForStorage(normalized));
}

export function removeCreatedWalletPoolPosition(
  network: string,
  poolId: string,
  walletId?: number | string
): void {
  const storageKey = getCreatedWalletPoolsStorageKey(network, walletId);
  const positions = loadCreatedWalletPoolPositions(network, walletId).filter((position) => getPoolSelectionId(position.pool) !== poolId);
  if (positions.length === 0) return removeCauldronPoolStorageItem(storageKey);
  setCauldronPoolStorageItem(storageKey, serializeForStorage(serializeWalletPoolPositions(positions)));
}

export function filterSuppressedWalletPoolPositions(
  positions: CauldronWalletPoolPosition[],
  suppressedPoolIds: string[]
): CauldronWalletPoolPosition[] {
  if (suppressedPoolIds.length === 0) return positions;
  const suppressedPoolIdSet = new Set(suppressedPoolIds);
  return positions.filter((position) => !suppressedPoolIdSet.has(getPoolSelectionId(position.pool)));
}

export function aggregatePoolTrades(
  poolTrades: CauldronPoolTrade[]
): CauldronPoolTrade[] {
  const byPool = new Map<string, CauldronPoolTrade>();
  for (const trade of poolTrades) {
    const key = [getPoolSelectionId(trade.pool), trade.supplyTokenId, trade.demandTokenId].join(':');
    const existing = byPool.get(key);
    if (!existing) {
      byPool.set(key, { ...trade });
      continue;
    }
    byPool.set(key, {
      ...existing,
      supply: existing.supply + trade.supply,
      demand: existing.demand + trade.demand,
      tradeFee: existing.tradeFee + trade.tradeFee,
    });
  }
  return [...byPool.values()];
}

export function findMinExecutableRouteAmount(params: {
  pools: CauldronPool[];
  supplyTokenId: string;
  demandTokenId: string;
  maxAmount: bigint;
}) {
  const { pools, supplyTokenId, demandTokenId, maxAmount } = params;
  if (maxAmount <= 0n) return 0n;
  let left = 1n;
  let right = maxAmount;
  let result: bigint | null = null;
  while (left <= right) {
    const mid = (left + right) / 2n;
    const plan = planAggregatedTradeForTargetSupply(pools, supplyTokenId, demandTokenId, mid);
    if (plan) {
      result = mid;
      if (mid === 0n) break;
      right = mid - 1n;
    } else {
      left = mid + 1n;
    }
  }
  return result ?? 0n;
}

export function formatTimestamp(timestamp: number): string {
  try {
    return new Date(timestamp * 1000).toLocaleString();
  } catch {
    return String(timestamp);
  }
}

export function mergeTokenCatalog(
  apiTokens: NormalizedCauldronToken[],
  pools: CauldronPool[]
): NormalizedCauldronToken[] {
  const byId = new Map<string, NormalizedCauldronToken>();
  for (const token of apiTokens) byId.set(token.tokenId, token);
  for (const pool of pools) {
    if (!byId.has(pool.output.tokenCategory)) {
      byId.set(pool.output.tokenCategory, {
        tokenId: pool.output.tokenCategory,
        symbol: pool.output.tokenCategory.slice(0, 6).toUpperCase(),
        name: `Token ${pool.output.tokenCategory.slice(0, 8)}`,
        decimals: null,
        imageUrl: null,
        tvlSats: 0,
      });
    }
  }
  return [...byId.values()].sort((a, b) => (b.tvlSats !== a.tvlSats ? b.tvlSats - a.tvlSats : a.symbol.localeCompare(b.symbol)));
}

export function formatBchAmount(valueSats: bigint): string {
  return (Number(valueSats) / 100_000_000).toFixed(8);
}
export function formatCompactBchAmount(valueSats: bigint): string {
  return `${parseFloat(formatBchAmount(valueSats)).toString()} BCH`;
}
export function formatTokenAmount(value: bigint, decimals = 0): string {
  if (decimals <= 0) return value.toString();
  const raw = value.toString().padStart(decimals + 1, '0');
  const whole = raw.slice(0, -decimals);
  const fraction = raw.slice(-decimals).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}
export function formatTokenDisplayAmount(value: bigint, decimals = 0, symbol?: string): string {
  const amount = formatTokenAmount(value, decimals);
  return symbol ? `${amount} ${symbol}` : amount;
}
export function formatApproxDisplayNumber(value: number, maxFractionDigits = 8): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  return value.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: maxFractionDigits, useGrouping: false });
}
export function parseDisplayAmountToNumber(value: string): number | null {
  const normalized = value.replace(/,/g, '').trim();
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
export function formatSignedBchAmount(valueSats: bigint): string {
  const sign = valueSats > 0n ? '+' : valueSats < 0n ? '-' : '';
  const absolute = valueSats < 0n ? -valueSats : valueSats;
  return `${sign}${formatCompactBchAmount(absolute)}`;
}
export function formatSignedTokenDisplayAmount(value: bigint, decimals = 0, symbol?: string): string {
  const sign = value > 0n ? '+' : value < 0n ? '-' : '';
  const absolute = value < 0n ? -value : value;
  return `${sign}${formatTokenDisplayAmount(absolute, decimals, symbol)}`;
}

export function derivePoolTokenAmountFromSpotPrice(params: {
  bchAmountSats: bigint | null;
  tokenSpotPriceSats: number | null;
  decimals: number;
  maxTokenAmountAtomic?: bigint | null;
}): string {
  const { bchAmountSats, tokenSpotPriceSats, decimals, maxTokenAmountAtomic } = params;
  if (bchAmountSats == null || bchAmountSats <= 0n || tokenSpotPriceSats == null || !Number.isFinite(tokenSpotPriceSats) || tokenSpotPriceSats <= 0) return '';
  const scaledPrice = BigInt(Math.round(tokenSpotPriceSats * 1_000_000));
  if (scaledPrice <= 0n) return '';
  const tokenAmountAtomic = (bchAmountSats * 1_000_000n) / scaledPrice;
  const cappedTokenAmountAtomic = maxTokenAmountAtomic != null && maxTokenAmountAtomic >= 0n && tokenAmountAtomic > maxTokenAmountAtomic ? maxTokenAmountAtomic : tokenAmountAtomic;
  return cappedTokenAmountAtomic > 0n ? formatTokenAmount(cappedTokenAmountAtomic, decimals) : '';
}

export function derivePoolBchAmountFromSpotPrice(params: {
  tokenAmountAtomic: bigint | null;
  tokenSpotPriceSats: number | null;
  maxBchAmountSats?: bigint | null;
}): string {
  const { tokenAmountAtomic, tokenSpotPriceSats, maxBchAmountSats } = params;
  if (tokenAmountAtomic == null || tokenAmountAtomic <= 0n || tokenSpotPriceSats == null || !Number.isFinite(tokenSpotPriceSats) || tokenSpotPriceSats <= 0) return '';
  const scaledPrice = BigInt(Math.round(tokenSpotPriceSats * 1_000_000));
  if (scaledPrice <= 0n) return '';
  const bchAmountSats = (tokenAmountAtomic * scaledPrice) / 1_000_000n;
  const cappedBchAmountSats = maxBchAmountSats != null && maxBchAmountSats >= 0n && bchAmountSats > maxBchAmountSats ? maxBchAmountSats : bchAmountSats;
  return cappedBchAmountSats > 0n ? formatTokenAmount(cappedBchAmountSats, 8) : '';
}

export function mergeWalletUtxoLists(res: { allUtxos: UTXO[]; tokenUtxos: UTXO[] }): UTXO[] {
  const byOutpoint = new Map<string, UTXO>();
  for (const utxo of [...res.allUtxos, ...res.tokenUtxos]) {
    byOutpoint.set(`${utxo.tx_hash}:${utxo.tx_pos}`, utxo);
  }
  return [...byOutpoint.values()];
}

export function stripChaingraphHexBytes(value: unknown): string {
  if (!value) return '';
  return String(value).trim().toLowerCase().replace(/^\\x/i, '').replace(/^0x/i, '');
}
export function getChainRowLockingBytecode(row: Record<string, unknown>, fallback: Uint8Array): Uint8Array {
  const lockingBytecodeHex = stripChaingraphHexBytes(row.locking_bytecode ?? row.lockingBytecode);
  return lockingBytecodeHex ? hexToBin(lockingBytecodeHex) : fallback;
}

export function parseWalletOwnedChainPools(params: {
  rows: Array<Record<string, unknown>>;
  ownerAddress: string | null;
  withdrawPublicKeyHash: Uint8Array | null;
}): Array<{ pool: CauldronPool; historyPoolId: string | null }> {
  const { rows, ownerAddress, withdrawPublicKeyHash } = params;
  return rows.flatMap((row) => {
    const category = stripChaingraphHexBytes(row.token_category);
    const txHash = stripChaingraphHexBytes(row.transaction_hash ?? row.txid ?? row.tx_hash ?? row.new_utxo_txid);
    const outputIndex = Number(row.output_index ?? row.tx_pos ?? row.vout ?? row.new_utxo_n ?? 0);
    const valueSatoshis = parseSatoshis(row.value_satoshis ?? row.value ?? row.sats ?? row.amount);
    const fungibleTokenAmount = parseSatoshis(row.fungible_token_amount ?? row.token_amount ?? row.amount_token ?? row.tokenAmount ?? row.tokens);
    const lockingBytecode = getChainRowLockingBytecode(row, new Uint8Array());
    if (!category || !txHash || fungibleTokenAmount <= 0n || valueSatoshis <= 0n || !withdrawPublicKeyHash) return [];
    const parsed = tryParseCauldronPoolFromUtxo({
      tx_hash: txHash,
      tx_pos: outputIndex,
      value: Number(valueSatoshis),
      amount: Number(valueSatoshis),
      token: { category, amount: fungibleTokenAmount },
      lockingBytecode,
    }, { withdrawPublicKeyHash });
    if (!parsed) return [];
    return [{ pool: { ...parsed, ownerAddress, ownerPublicKeyHash: binToHex(withdrawPublicKeyHash) }, historyPoolId: typeof row.pool_id === 'string' && row.pool_id.trim() ? row.pool_id.trim() : null }];
  });
}

export function fuzzyTokenMatchScore(query: string, symbol: string, name: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const symbolValue = symbol.toLowerCase();
  const nameValue = name.toLowerCase();
  const combined = `${symbolValue} ${nameValue}`;
  if (symbolValue === q) return 1000;
  if (nameValue === q) return 950;
  if (symbolValue.startsWith(q)) return 900;
  if (nameValue.startsWith(q)) return 850;
  if (symbolValue.includes(q)) return 800;
  if (nameValue.includes(q)) return 750;
  if (combined.includes(q)) return 700;
  let cursor = 0;
  for (const char of combined) {
    if (char === q[cursor]) {
      cursor += 1;
      if (cursor === q.length) return 500 - combined.length;
    }
  }
  return -1;
}

export function applySlippage(amount: bigint, bps: bigint): bigint {
  return (amount * (10_000n - bps)) / 10_000n;
}
export function estimateBps(part: bigint, total: bigint): bigint {
  if (part <= 0n || total <= 0n) return 0n;
  return (part * 10_000n) / total;
}
export function formatLiquidityUsageWarning(label: string, usedBps: bigint): string {
  return `${label} is using about ${(Number(usedBps) / 100).toFixed(2)}% of the currently executable market depth. Liquidity may move before you can unwind this position.`;
}
export function shortAddress(value: string): string {
  if (!value) return '';
  return value.length <= 18 ? value : `${value.slice(0, 10)}...${value.slice(-6)}`;
}
export function lockingBytecodeToDisplayAddress(lockingBytecode: Uint8Array, network: Network): string | null {
  const result = lockingBytecodeToCashAddress({ bytecode: lockingBytecode, prefix: network === 'chipnet' ? 'bchtest' : 'bitcoincash', tokenSupport: false });
  if (typeof result === 'string') return null;
  return result.address;
}
export function collectWalletPublicKeyHashes(
  addresses: Array<{ address: string; tokenAddress?: string }>
): Set<string> {
  return new Set(
    addresses.flatMap((entry) => [entry.address, entry.tokenAddress].filter(Boolean) as string[]).map((address) => {
      try {
        return binToHex(derivePublicKeyHash(address)).toLowerCase();
      } catch {
        return null;
      }
    }).filter((value): value is string => Boolean(value))
  );
}
export function filterWalletPoolPositionsOwnedByWallet(
  positions: CauldronWalletPoolPosition[],
  addresses: Array<{ address: string; tokenAddress?: string }>
): CauldronWalletPoolPosition[] {
  if (positions.length === 0 || addresses.length === 0) return [];
  const walletPublicKeyHashes = collectWalletPublicKeyHashes(addresses);
  const walletAddresses = new Set(addresses.flatMap((entry) => [entry.address, entry.tokenAddress].filter(Boolean) as string[]).map((address) => address.trim().toLowerCase()));
  return positions.filter((position) => {
    const ownerPkh = position.pool.ownerPublicKeyHash?.trim().toLowerCase() ?? '';
    const ownerAddress = position.pool.ownerAddress?.trim().toLowerCase() ?? '';
    const positionOwnerAddress = position.ownerAddress?.trim().toLowerCase() ?? '';
    return walletPublicKeyHashes.has(ownerPkh) || walletAddresses.has(ownerAddress) || walletAddresses.has(positionOwnerAddress);
  });
}
export function resolveWalletAddressForPublicKeyHash(
  addresses: Array<{ address: string; tokenAddress?: string }>,
  targetPublicKeyHash: Uint8Array
): string | null {
  const targetHex = binToHex(targetPublicKeyHash).toLowerCase();
  for (const entry of addresses) {
    for (const candidateAddress of [entry.address, entry.tokenAddress]) {
      if (!candidateAddress) continue;
      try {
        if (binToHex(derivePublicKeyHash(candidateAddress)).toLowerCase() === targetHex) {
          return entry.address || candidateAddress;
        }
      } catch {
        continue;
      }
    }
  }
  return null;
}
export function resolvePoolWithdrawalOwnerAddress(args: {
  addresses: Array<{ address: string; tokenAddress?: string }>;
  poolOwnerAddress?: string | null;
  withdrawPublicKeyHash: Uint8Array;
}): string {
  const { addresses, poolOwnerAddress, withdrawPublicKeyHash } = args;
  return poolOwnerAddress?.trim() || resolveWalletAddressForPublicKeyHash(addresses, withdrawPublicKeyHash) || addresses[0]?.address || addresses[0]?.tokenAddress || '';
}

export function derivePoolHistoryStats(
  history: CauldronPoolHistoryResponse | null
): { sampleSize: number; grossYieldPercent: string | null; bchReserveChange: bigint | null; tokenReserveChange: bigint | null } {
  const entries = history?.history ?? [];
  if (entries.length < 2) {
    return { sampleSize: entries.length, grossYieldPercent: null, bchReserveChange: null, tokenReserveChange: null };
  }
  const start = entries[0];
  const end = entries[entries.length - 1];
  const startSats = Number(start.sats);
  const endSats = Number(end.sats);
  const startTokens = Number(start.tokens);
  const endTokens = Number(end.tokens);
  let grossYieldPercent: string | null = null;
  if (startSats > 0 && endSats > 0 && startTokens > 0 && endTokens > 0) {
    const grossYield = Math.sqrt((endSats / startSats) * (endTokens / startTokens)) - 1;
    if (Number.isFinite(grossYield)) grossYieldPercent = `${(grossYield * 100).toFixed(2)}%`;
  }
  return {
    sampleSize: entries.length,
    grossYieldPercent,
    bchReserveChange: parseSatoshis(end.sats) - parseSatoshis(start.sats),
    tokenReserveChange: parseSatoshis(end.tokens) - parseSatoshis(start.tokens),
  };
}

export function getPoolSelectionId(pool: Pick<CauldronPool, 'txHash' | 'outputIndex' | 'poolId'>): string {
  return pool.poolId || `${pool.txHash}:${pool.outputIndex}`;
}

export async function fetchWalletCreatedCauldronPools(
  walletId: number,
  network: string,
  apiClient: CauldronApiClient
): Promise<CauldronPool[]> {
  const walletScopedRecords = await OutboundTransactionTracker.listAll(walletId);
  let candidates = collectWalletCreatedCauldronPoolCandidates(walletScopedRecords);
  if (candidates.length === 0) {
    const allRecords = await OutboundTransactionTracker.listAll(null);
    if (allRecords.length > walletScopedRecords.length) {
      candidates = collectWalletCreatedCauldronPoolCandidates(allRecords);
    }
  }
  if (candidates.length === 0) return [];
  const candidateKeys = new Set(candidates.map((candidate) => `${candidate.txHash}:${candidate.outputIndex}`));
  const tokenIds = [...new Set(candidates.map((candidate) => candidate.tokenCategory))];
  const pools = new Map<string, CauldronPool>();
  const rowsByToken = await Promise.allSettled(
    tokenIds.map((tokenId) =>
      fetchNormalizedCauldronPools(network as Network, apiClient, tokenId)
    )
  );
  for (const settled of rowsByToken) {
    if (settled.status !== 'fulfilled') continue;
    for (const pool of settled.value as CauldronPool[]) {
      const selectionId = getPoolSelectionId(pool);
      const candidateKey = `${pool.txHash}:${pool.outputIndex}`;
      if (!candidateKeys.has(candidateKey)) continue;
      if (!pools.has(selectionId)) pools.set(selectionId, pool);
    }
  }
  return [...pools.values()];
}

export function parseApyPercent(
  value: string | number | null
): string | null {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return `${value.toFixed(2)}%`;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? `${trimmed}%` : null;
  }
  return null;
}
