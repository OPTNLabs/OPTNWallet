import React, {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useSelector } from 'react-redux';
import {
  binToHex,
  hexToBin,
} from '@bitauth/libauth';

import type { AddonSDK } from '../../../services/AddonsSDK';
import type { AddonAppDefinition, AddonManifest } from '../../../types/addons';
import type { Network } from '../../../state/slices/networkSlice';
import { selectCurrentNetwork } from '../../../state/selectors/networkSelectors';
import type { RootState } from '../../../state/store';
import KeyService from '../../../services/KeyService';
import useSharedTokenMetadata from '../../../hooks/useSharedTokenMetadata';
import { ensureUint8Array, parseSatoshis } from '../../../utils/binary';
import { derivePublicKeyHash } from '../../../utils/derivePublicKeyHash';
import { shortenHash } from '../../../utils/shortenHash';
import {
  buildCauldronPoolV0LockingBytecode,
  getCauldronPoolV0WithdrawPublicKeyHash,
  CAULDRON_NATIVE_BCH,
  CAULDRON_V0_VERSION,
  CauldronApiClient,
  type BuiltCauldronPoolDepositRequest,
  type BuiltCauldronPoolWithdrawRequest,
  buildCauldronPoolDepositRequest,
  buildCauldronTradeRequest,
  buildCauldronPoolWithdrawRequest,
  analyzeCauldronMarketLiquidity,
  collectWalletCreatedCauldronPoolCandidates,
  detectCauldronWalletPoolPositions,
  fetchCauldronDerivedWalletAddresses,
  fetchNormalizedCauldronPools,
  fetchNormalizedCauldronUserPools,
  getCauldronSubscriptionService,
  normalizeCauldronPoolRow,
  normalizeCauldronTokenRow,
  planAggregatedTradeForTargetSupply,
  resolveCauldronFundingInputs,
  signAndBroadcastCauldronPoolDepositRequest,
  signAndBroadcastCauldronTradeRequest,
  signAndBroadcastCauldronPoolWithdrawRequest,
  tryParseCauldronPoolFromUtxo,
  type BuiltCauldronTradeRequest,
  type CauldronAggregatedApyResponse,
  type CauldronPool,
  type CauldronPoolHistoryResponse,
  type CauldronPoolTrade,
  type CauldronWalletPoolPosition,
  type NormalizedCauldronToken,
} from '../../../services/cauldron';
import { classifyCauldronQuoteFailure } from '../../../services/cauldron/quoteFailure';
import type { UTXO } from '../../../types/types';
import {
  parseBchInputToSats,
  parseDecimalToAtomic,
  selectExecutableSwapMaxAtomic,
  sanitizeDecimalInput,
} from '../../../services/cauldron/amount';
import {
  assertWalletInputsStillAvailable,
  fetchCurrentQuotedPoolsFromChain,
  fetchVisiblePoolsFromChain,
  getPoolSelectionId,
  resolveCurrentPoolForReview,
} from './preflight';
import { ContainedSwipeConfirmModal } from '../mint-cashtokens-poc/components/uiPrimitives';
import { getReturnPath } from '../../../utils/navigation';
import {
  selectFundingUtxosByToken,
  selectLargestBchUtxos,
  selectWalletBchFundingUtxo,
  sumSpendableBchBalance,
  sumSpendableTokenBalance,
} from './funding';
import {
  buildCauldronQuoteSafetyBanner,
  type CauldronQuoteSafetyBanner,
} from './quoteSafety';
import { useSmoothResetTransition } from '../shared/useSmoothResetTransition';
import OutboundTransactionTracker from '../../../services/OutboundTransactionTracker';
import {
  formatTimestamp,
  dedupeWalletPoolPositionsForDisplay,
  shortTokenId,
} from './cauldronHelpers';

type CauldronSwapAppProps = {
  sdk: AddonSDK;
  manifest: AddonManifest;
  app: AddonAppDefinition;
};

type SwapDirection = 'bch_to_token' | 'token_to_bch';
type CauldronView = 'swap' | 'pool';

type QuoteState = {
  trades: CauldronPoolTrade[];
  totalSupply: bigint;
  totalDemand: bigint;
  estimatedFeeSatoshis: bigint;
  minReceive: bigint;
  built: BuiltCauldronTradeRequest;
  builtAt: number;
  usedCachedPools: boolean;
  slippageBps: bigint;
  marketUsageBps: bigint;
  routePoolCount: number;
  walletInputCount: number;
  warnings: string[];
};

type PoolReviewState =
  | {
      kind: 'create';
      built: BuiltCauldronPoolDepositRequest;
      bchAmount: bigint;
      tokenAmount: bigint;
      ownerAddress: string;
    }
  | {
      kind: 'withdraw';
      built: BuiltCauldronPoolWithdrawRequest;
      pool: CauldronPool;
    };

const SAFETY_MAX_ROUTE_POOLS = 4;
const SAFETY_MAX_WALLET_INPUTS = 4;
const SAFETY_HIGH_SLIPPAGE_BPS = 300n;
const SAFETY_HIGH_FEE_BPS = 100n;
const SAFETY_LOW_LIQUIDITY_BPS = 8000n;
const CAULDRON_MESSAGE_AUTO_DISMISS_MS = 4200;
const PENDING_WALLET_POOLS_STORAGE_PREFIX =
  'optn.cauldron.pending-wallet-pools';
const WALLET_POOLS_STORAGE_PREFIX = 'optn.cauldron.wallet-pools';
const CREATED_WALLET_POOLS_STORAGE_PREFIX =
  'optn.cauldron.created-wallet-pools';
const CREATED_WALLET_POOL_TOKENS_STORAGE_PREFIX =
  'optn.cauldron.created-wallet-pool-tokens';
const CREATED_WALLET_POOL_LOCKING_BYTECODES_STORAGE_PREFIX =
  'optn.cauldron.created-wallet-pool-locking-bytecodes';

function dedupePoolsBySelectionId(pools: CauldronPool[]): CauldronPool[] {
  const byId = new Map<string, CauldronPool>();
  for (const pool of pools) {
    byId.set(getPoolSelectionId(pool), pool);
  }
  return [...byId.values()];
}

function dedupeWalletPoolPositions(
  positions: CauldronWalletPoolPosition[]
): CauldronWalletPoolPosition[] {
  const byId = new Map<string, CauldronWalletPoolPosition>();
  for (const position of positions) {
    byId.set(getPoolSelectionId(position.pool), position);
  }
  return [...byId.values()];
}

type PersistedPendingWalletPoolPosition = {
  pool: CauldronPool;
  ownerAddress: string | null;
  historyPoolId?: string | null;
  detectionSource: CauldronWalletPoolPosition['detectionSource'];
};

type PersistedBigIntValue = {
  __bigint__: string;
};

function isPersistedBigIntValue(value: unknown): value is PersistedBigIntValue {
  return Boolean(
    value &&
      typeof value === 'object' &&
      '__bigint__' in value &&
      typeof (value as PersistedBigIntValue).__bigint__ === 'string'
  );
}

function serializeForStorage(value: unknown): string {
  return JSON.stringify(value, (_key, nextValue) =>
    typeof nextValue === 'bigint'
      ? { __bigint__: nextValue.toString() }
      : nextValue
  );
}

function deserializeFromStorage<T>(raw: string | null): T | null {
  if (!raw) return null;

  try {
    return JSON.parse(raw, (_key, nextValue) => {
      if (isPersistedBigIntValue(nextValue)) {
        return BigInt(nextValue.__bigint__);
      }
      return nextValue;
    }) as T;
  } catch {
    return null;
  }
}

function getPendingWalletPoolsStorageKey(network: string): string {
  return `${PENDING_WALLET_POOLS_STORAGE_PREFIX}:${network}`;
}

function getWalletPoolsStorageKey(network: string): string {
  return `${WALLET_POOLS_STORAGE_PREFIX}:${network}`;
}

function getCreatedWalletPoolsStorageKey(network: string): string {
  return `${CREATED_WALLET_POOLS_STORAGE_PREFIX}:${network}`;
}

function getCreatedWalletPoolTokensStorageKey(network: string): string {
  return `${CREATED_WALLET_POOL_TOKENS_STORAGE_PREFIX}:${network}`;
}

function getCreatedWalletPoolLockingBytecodesStorageKey(
  network: string
): string {
  return `${CREATED_WALLET_POOL_LOCKING_BYTECODES_STORAGE_PREFIX}:${network}`;
}

function getCauldronPoolStorage(): Storage | null {
  return globalThis.localStorage ?? globalThis.sessionStorage ?? null;
}

function getCauldronPoolStorageItem(key: string): string | null {
  return getCauldronPoolStorage()?.getItem(key) ?? null;
}

function resolveCauldronPoolWithdrawPublicKeyHash(
  pool: Pick<CauldronPool, 'output' | 'parameters'>
): Uint8Array {
  const direct = ensureUint8Array(pool.parameters.withdrawPublicKeyHash);
  if (direct.length === 20) return direct;

  const recovered = getCauldronPoolV0WithdrawPublicKeyHash(
    ensureUint8Array(pool.output.lockingBytecode)
  );
  if (recovered?.length === 20) return recovered;

  return direct;
}

function setCauldronPoolStorageItem(key: string, value: string): void {
  getCauldronPoolStorage()?.setItem(key, value);
}

function removeCauldronPoolStorageItem(key: string): void {
  getCauldronPoolStorage()?.removeItem(key);
}

function logCauldronTxPlan(
  stage: string,
  payload: Record<string, unknown>
): void {
  if (!import.meta.env.DEV) return;
  console.debug(`[Cauldron:TX] ${stage}`, payload);
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown error';
}

function serializePendingWalletPoolPositions(
  positions: CauldronWalletPoolPosition[]
): PersistedPendingWalletPoolPosition[] {
  return positions.map((position) => ({
    pool: position.pool,
    ownerAddress: position.ownerAddress ?? null,
    historyPoolId: position.historyPoolId ?? null,
    detectionSource: position.detectionSource,
  }));
}

function deserializePendingWalletPoolPositions(
  raw: string | null
): CauldronWalletPoolPosition[] {
  const parsed = deserializeFromStorage<unknown>(raw);
  if (!Array.isArray(parsed)) return [];

  function normalizePersistedPool(
    pool: PersistedPendingWalletPoolPosition['pool']
  ): CauldronPool {
    const withdrawPublicKeyHash = resolveCauldronPoolWithdrawPublicKeyHash({
      output: pool.output,
      parameters: pool.parameters,
    });
    return {
      ...pool,
      parameters: {
        withdrawPublicKeyHash,
      },
      output: {
        ...pool.output,
        lockingBytecode: ensureUint8Array(pool.output.lockingBytecode),
      },
    };
  }

  return parsed.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const candidate = entry as PersistedPendingWalletPoolPosition;
    if (
      !candidate.pool ||
      !candidate.pool.output ||
      !candidate.pool.parameters
    ) {
      return [];
    }
    return [
      {
        pool: normalizePersistedPool(candidate.pool),
        ownerAddress:
          typeof candidate.ownerAddress === 'string'
            ? candidate.ownerAddress
            : null,
        historyPoolId:
          typeof candidate.historyPoolId === 'string'
            ? candidate.historyPoolId
            : null,
        matchingNftUtxos: [],
        hasMatchingTokenNft: false,
        detectionSource: candidate.detectionSource ?? 'owner_pkh',
      },
    ];
  });
}

function serializeWalletPoolPositions(
  positions: CauldronWalletPoolPosition[]
): PersistedPendingWalletPoolPosition[] {
  return serializePendingWalletPoolPositions(positions);
}

function deserializeWalletPoolPositions(
  raw: string | null
): CauldronWalletPoolPosition[] {
  return deserializePendingWalletPoolPositions(raw);
}

function loadCreatedWalletPoolPositions(
  network: string
): CauldronWalletPoolPosition[] {
  const raw = getCauldronPoolStorageItem(
    getCreatedWalletPoolsStorageKey(network)
  );
  return dedupeWalletPoolPositions(deserializeWalletPoolPositions(raw));
}

function loadWalletPoolPositionsFromStorage(
  network: string
): CauldronWalletPoolPosition[] {
  const raw = getCauldronPoolStorageItem(getWalletPoolsStorageKey(network));
  return dedupeWalletPoolPositions(deserializeWalletPoolPositions(raw));
}

function loadCreatedWalletPoolTokenCategories(network: string): string[] {
  const raw = deserializeFromStorage<unknown>(
    getCauldronPoolStorageItem(getCreatedWalletPoolTokensStorageKey(network))
  );
  if (!Array.isArray(raw)) return [];
  return [
    ...new Set(
      raw
        .map((tokenId) =>
          typeof tokenId === 'string' ? tokenId.toLowerCase() : ''
        )
        .filter((tokenId): tokenId is string => Boolean(tokenId))
    ),
  ];
}

function buildCreatedPoolParametersByLockingBytecode(
  pools: Array<CauldronPool | CauldronWalletPoolPosition>
): Map<string, Uint8Array> {
  const byBytecode = new Map<string, Uint8Array>();
  for (const entry of pools) {
    const pool = 'pool' in entry ? entry.pool : entry;
    const bytecodeHex = binToHex(pool.output.lockingBytecode).toLowerCase();
    byBytecode.set(bytecodeHex, pool.parameters.withdrawPublicKeyHash);
  }
  return byBytecode;
}

function collectPoolTokenCategories(
  entries: Array<CauldronPool | CauldronWalletPoolPosition>
): string[] {
  return [
    ...new Set(
      entries
        .map((entry) =>
          'pool' in entry
            ? entry.pool.output.tokenCategory
            : entry.output.tokenCategory
        )
        .map((tokenId) => tokenId?.toLowerCase())
        .filter((tokenId): tokenId is string => Boolean(tokenId))
    ),
  ];
}

function persistCreatedWalletPoolPositions(
  network: string,
  positions: CauldronWalletPoolPosition[]
): void {
  const storageKey = getCreatedWalletPoolsStorageKey(network);
  if (positions.length === 0) {
    removeCauldronPoolStorageItem(storageKey);
    return;
  }
  setCauldronPoolStorageItem(
    storageKey,
    serializeForStorage(serializeWalletPoolPositions(positions))
  );
}

function loadCreatedWalletPoolLockingBytecodes(network: string): Uint8Array[] {
  const raw = deserializeFromStorage<unknown>(
    getCauldronPoolStorageItem(
      getCreatedWalletPoolLockingBytecodesStorageKey(network)
    )
  );
  if (!Array.isArray(raw)) return [];
  return [
    ...new Set(
      raw
        .map((value) =>
          typeof value === 'string' ? value.toLowerCase().trim() : ''
        )
        .filter((value): value is string => Boolean(value))
    ),
  ].flatMap((hex) => {
    try {
      return [hexToBin(hex)];
    } catch {
      return [];
    }
  });
}

function persistCreatedWalletPoolTokenCategories(
  network: string,
  tokenIds: string[]
): void {
  const storageKey = getCreatedWalletPoolTokensStorageKey(network);
  const normalized = [
    ...new Set(tokenIds.map((tokenId) => tokenId.toLowerCase())),
  ];
  if (normalized.length === 0) {
    removeCauldronPoolStorageItem(storageKey);
    return;
  }
  setCauldronPoolStorageItem(storageKey, serializeForStorage(normalized));
}

function persistCreatedWalletPoolLockingBytecodes(
  network: string,
  lockingBytecodes: Uint8Array[]
): void {
  const storageKey = getCreatedWalletPoolLockingBytecodesStorageKey(network);
  const normalized = [
    ...new Set(
      lockingBytecodes.map((bytecode) => binToHex(bytecode).toLowerCase())
    ),
  ];
  if (normalized.length === 0) {
    removeCauldronPoolStorageItem(storageKey);
    return;
  }
  setCauldronPoolStorageItem(storageKey, serializeForStorage(normalized));
}

function removeCreatedWalletPoolPosition(
  network: string,
  poolId: string
): void {
  const storageKey = getCreatedWalletPoolsStorageKey(network);
  const positions = loadCreatedWalletPoolPositions(network).filter(
    (position) => getPoolSelectionId(position.pool) !== poolId
  );
  if (positions.length === 0) {
    removeCauldronPoolStorageItem(storageKey);
    return;
  }
  setCauldronPoolStorageItem(
    storageKey,
    serializeForStorage(serializeWalletPoolPositions(positions))
  );
}

function filterSuppressedWalletPoolPositions(
  positions: CauldronWalletPoolPosition[],
  suppressedPoolIds: string[]
): CauldronWalletPoolPosition[] {
  if (suppressedPoolIds.length === 0) return positions;
  const suppressedPoolIdSet = new Set(suppressedPoolIds);
  return positions.filter(
    (position) => !suppressedPoolIdSet.has(getPoolSelectionId(position.pool))
  );
}

function aggregatePoolTrades(
  poolTrades: CauldronPoolTrade[]
): CauldronPoolTrade[] {
  const byPool = new Map<string, CauldronPoolTrade>();
  for (const trade of poolTrades) {
    const key = [
      getPoolSelectionId(trade.pool),
      trade.supplyTokenId,
      trade.demandTokenId,
    ].join(':');
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

function findMinExecutableRouteAmount(params: {
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
    const plan = planAggregatedTradeForTargetSupply(
      pools,
      supplyTokenId,
      demandTokenId,
      mid
    );
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

function mergeTokenCatalog(
  apiTokens: NormalizedCauldronToken[],
  pools: CauldronPool[]
): NormalizedCauldronToken[] {
  const byId = new Map<string, NormalizedCauldronToken>();

  for (const token of apiTokens) {
    byId.set(token.tokenId, token);
  }

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

  return [...byId.values()].sort((a, b) => {
    if (b.tvlSats !== a.tvlSats) return b.tvlSats - a.tvlSats;
    return a.symbol.localeCompare(b.symbol);
  });
}

function formatBchAmount(valueSats: bigint): string {
  return (Number(valueSats) / 100_000_000).toFixed(8);
}

function formatCompactBchAmount(valueSats: bigint): string {
  return `${parseFloat(formatBchAmount(valueSats)).toString()} BCH`;
}

function formatTokenAmount(value: bigint, decimals = 0): string {
  if (decimals <= 0) return value.toString();
  const raw = value.toString().padStart(decimals + 1, '0');
  const whole = raw.slice(0, -decimals);
  const fraction = raw.slice(-decimals).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

function formatTokenDisplayAmount(
  value: bigint,
  decimals = 0,
  symbol?: string
): string {
  const amount = formatTokenAmount(value, decimals);
  return symbol ? `${amount} ${symbol}` : amount;
}

function formatApproxDisplayNumber(
  value: number,
  maxFractionDigits = 8
): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  return value.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: maxFractionDigits,
    useGrouping: false,
  });
}

function parseDisplayAmountToNumber(value: string): number | null {
  const normalized = value.replace(/,/g, '').trim();
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function formatSignedBchAmount(valueSats: bigint): string {
  const sign = valueSats > 0n ? '+' : valueSats < 0n ? '-' : '';
  const absolute = valueSats < 0n ? -valueSats : valueSats;
  return `${sign}${formatCompactBchAmount(absolute)}`;
}

function formatSignedTokenDisplayAmount(
  value: bigint,
  decimals = 0,
  symbol?: string
): string {
  const sign = value > 0n ? '+' : value < 0n ? '-' : '';
  const absolute = value < 0n ? -value : value;
  return `${sign}${formatTokenDisplayAmount(absolute, decimals, symbol)}`;
}

function derivePoolTokenAmountFromSpotPrice(params: {
  bchAmountSats: bigint | null;
  tokenSpotPriceSats: number | null;
  decimals: number;
  maxTokenAmountAtomic?: bigint | null;
}): string {
  const { bchAmountSats, tokenSpotPriceSats, decimals, maxTokenAmountAtomic } =
    params;
  if (
    bchAmountSats == null ||
    bchAmountSats <= 0n ||
    tokenSpotPriceSats == null ||
    !Number.isFinite(tokenSpotPriceSats) ||
    tokenSpotPriceSats <= 0
  ) {
    return '';
  }

  const scaledPrice = BigInt(Math.round(tokenSpotPriceSats * 1_000_000));
  if (scaledPrice <= 0n) return '';

  const tokenAmountAtomic = (bchAmountSats * 1_000_000n) / scaledPrice;
  const cappedTokenAmountAtomic =
    maxTokenAmountAtomic != null && maxTokenAmountAtomic >= 0n
      ? tokenAmountAtomic > maxTokenAmountAtomic
        ? maxTokenAmountAtomic
        : tokenAmountAtomic
      : tokenAmountAtomic;
  return cappedTokenAmountAtomic > 0n
    ? formatTokenAmount(cappedTokenAmountAtomic, decimals)
    : '';
}

function derivePoolBchAmountFromSpotPrice(params: {
  tokenAmountAtomic: bigint | null;
  tokenSpotPriceSats: number | null;
  maxBchAmountSats?: bigint | null;
}): string {
  const { tokenAmountAtomic, tokenSpotPriceSats, maxBchAmountSats } = params;
  if (
    tokenAmountAtomic == null ||
    tokenAmountAtomic <= 0n ||
    tokenSpotPriceSats == null ||
    !Number.isFinite(tokenSpotPriceSats) ||
    tokenSpotPriceSats <= 0
  ) {
    return '';
  }

  const scaledPrice = BigInt(Math.round(tokenSpotPriceSats * 1_000_000));
  if (scaledPrice <= 0n) return '';

  const bchAmountSats = (tokenAmountAtomic * scaledPrice) / 1_000_000n;
  const cappedBchAmountSats =
    maxBchAmountSats != null && maxBchAmountSats >= 0n
      ? bchAmountSats > maxBchAmountSats
        ? maxBchAmountSats
        : bchAmountSats
      : bchAmountSats;
  return cappedBchAmountSats > 0n
    ? formatTokenAmount(cappedBchAmountSats, 8)
    : '';
}

function mergeWalletUtxoLists(res: {
  allUtxos: UTXO[];
  tokenUtxos: UTXO[];
}): UTXO[] {
  const byOutpoint = new Map<string, UTXO>();
  for (const utxo of [...res.allUtxos, ...res.tokenUtxos]) {
    byOutpoint.set(`${utxo.tx_hash}:${utxo.tx_pos}`, utxo);
  }
  return [...byOutpoint.values()];
}

function stripChaingraphHexBytes(value: unknown): string {
  if (!value) return '';
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/^\\x/i, '')
    .replace(/^0x/i, '');
}

function getChainRowLockingBytecode(
  row: Record<string, unknown>,
  fallback: Uint8Array
): Uint8Array {
  const lockingBytecodeHex = stripChaingraphHexBytes(
    row.locking_bytecode ?? row.lockingBytecode
  );
  return lockingBytecodeHex ? hexToBin(lockingBytecodeHex) : fallback;
}

function parseWalletOwnedChainPools(params: {
  rows: Array<Record<string, unknown>>;
  ownerAddress: string | null;
  withdrawPublicKeyHash: Uint8Array | null;
}): Array<{ pool: CauldronPool; historyPoolId: string | null }> {
  const { rows, ownerAddress, withdrawPublicKeyHash } = params;
  return rows.flatMap((row) => {
    const category = stripChaingraphHexBytes(row.token_category);
    const txHash = stripChaingraphHexBytes(
      row.transaction_hash ?? row.txid ?? row.tx_hash ?? row.new_utxo_txid
    );
    const outputIndex = Number(
      row.output_index ?? row.tx_pos ?? row.vout ?? row.new_utxo_n ?? 0
    );
    const valueSatoshis = parseSatoshis(
      row.value_satoshis ?? row.value ?? row.sats ?? row.amount
    );
    const fungibleTokenAmount = parseSatoshis(
      row.fungible_token_amount ??
        row.token_amount ??
        row.amount_token ??
        row.tokenAmount ??
        row.tokens
    );
    const lockingBytecode = getChainRowLockingBytecode(row, new Uint8Array());

    if (
      !category ||
      !txHash ||
      fungibleTokenAmount <= 0n ||
      valueSatoshis <= 0n ||
      !withdrawPublicKeyHash
    ) {
      return [];
    }

    const parsed = tryParseCauldronPoolFromUtxo(
      {
        tx_hash: txHash,
        tx_pos: outputIndex,
        value: Number(valueSatoshis),
        amount: Number(valueSatoshis),
        token: {
          category,
          amount: fungibleTokenAmount,
        },
        lockingBytecode,
      },
      { withdrawPublicKeyHash }
    );
    if (!parsed) return [];

    return [
      {
        pool: {
          ...parsed,
          ownerAddress,
          ownerPublicKeyHash: binToHex(withdrawPublicKeyHash),
        },
        historyPoolId:
          typeof row.pool_id === 'string' && row.pool_id.trim()
            ? row.pool_id.trim()
            : null,
      },
    ];
  });
}

async function fetchWalletOwnedPoolsFromChain(params: {
  sdk: AddonSDK;
  lockingBytecodes: Uint8Array[];
  tokenIds: string[];
  createdPoolParametersByLockingBytecode: Map<string, Uint8Array>;
}): Promise<CauldronWalletPoolPosition[]> {
  const {
    sdk,
    lockingBytecodes,
    tokenIds,
    createdPoolParametersByLockingBytecode,
  } = params;
  if (tokenIds.length === 0 || lockingBytecodes.length === 0) return [];

  const poolQueries = await Promise.all(
    lockingBytecodes.flatMap((lockingBytecode) => {
      const lockingBytecodeHex = binToHex(lockingBytecode);
      return tokenIds.map(async (tokenId) => {
        try {
          const response = await sdk.chain.queryUnspentByLockingBytecode(
            lockingBytecodeHex,
            tokenId
          );
          const rows = Array.isArray(response?.data?.output)
            ? (response.data.output as Array<Record<string, unknown>>)
            : [];
          const withdrawPublicKeyHash =
            createdPoolParametersByLockingBytecode.get(
              lockingBytecodeHex.toLowerCase()
            ) ?? null;
          const parsed = parseWalletOwnedChainPools({
            rows,
            ownerAddress: null,
            withdrawPublicKeyHash,
          });
          return parsed;
        } catch {
          return [];
        }
      });
    })
  );

  return dedupeWalletPoolPositions(
    poolQueries.flat().flatMap(({ pool, historyPoolId }) => ({
      pool,
      ownerAddress: pool.ownerAddress ?? null,
      historyPoolId,
      matchingNftUtxos: [],
      hasMatchingTokenNft: false,
      detectionSource: 'owner_pkh' as const,
    }))
  );
}

function fuzzyTokenMatchScore(
  query: string,
  symbol: string,
  name: string
): number {
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
      if (cursor === q.length) {
        return 500 - combined.length;
      }
    }
  }

  return -1;
}

function applySlippage(amount: bigint, bps: bigint): bigint {
  return (amount * (10_000n - bps)) / 10_000n;
}

function estimateBps(part: bigint, total: bigint): bigint {
  if (part <= 0n || total <= 0n) return 0n;
  return (part * 10_000n) / total;
}

function formatLiquidityUsageWarning(label: string, usedBps: bigint): string {
  return `${label} is using about ${(Number(usedBps) / 100).toFixed(2)}% of the currently executable market depth. Liquidity may move before you can unwind this position.`;
}

function collectWalletPublicKeyHashes(
  addresses: Array<{ address: string; tokenAddress?: string }>
): Set<string> {
  return new Set(
    addresses
      .flatMap(
        (entry) =>
          [entry.address, entry.tokenAddress].filter(Boolean) as string[]
      )
      .map((address) => {
        try {
          return binToHex(derivePublicKeyHash(address)).toLowerCase();
        } catch {
          return null;
        }
      })
      .filter((value): value is string => Boolean(value))
  );
}

function filterWalletPoolPositionsOwnedByWallet(
  positions: CauldronWalletPoolPosition[],
  addresses: Array<{ address: string; tokenAddress?: string }>
): CauldronWalletPoolPosition[] {
  if (positions.length === 0 || addresses.length === 0) return [];
  const walletPublicKeyHashes = collectWalletPublicKeyHashes(addresses);
  const walletAddresses = new Set(
    addresses
      .flatMap(
        (entry) =>
          [entry.address, entry.tokenAddress].filter(Boolean) as string[]
      )
      .map((address) => address.trim().toLowerCase())
  );
  return positions.filter((position) => {
    const ownerPkh =
      position.pool.ownerPublicKeyHash?.trim().toLowerCase() ?? '';
    const ownerAddress = position.pool.ownerAddress?.trim().toLowerCase() ?? '';
    const positionOwnerAddress =
      position.ownerAddress?.trim().toLowerCase() ?? '';
    return (
      walletPublicKeyHashes.has(ownerPkh) ||
      walletAddresses.has(ownerAddress) ||
      walletAddresses.has(positionOwnerAddress)
    );
  });
}

function resolveWalletAddressForPublicKeyHash(
  addresses: Array<{ address: string; tokenAddress?: string }>,
  targetPublicKeyHash: Uint8Array
): string | null {
  const targetHex = binToHex(targetPublicKeyHash).toLowerCase();
  for (const entry of addresses) {
    for (const candidateAddress of [entry.address, entry.tokenAddress]) {
      if (!candidateAddress) continue;
      try {
        if (
          binToHex(derivePublicKeyHash(candidateAddress)).toLowerCase() ===
          targetHex
        ) {
          return entry.address || candidateAddress;
        }
      } catch {
        continue;
      }
    }
  }
  return null;
}

function resolvePoolWithdrawalOwnerAddress(args: {
  addresses: Array<{ address: string; tokenAddress?: string }>;
  poolOwnerAddress?: string | null;
  withdrawPublicKeyHash: Uint8Array;
}): string {
  const { addresses, poolOwnerAddress, withdrawPublicKeyHash } = args;
  return (
    poolOwnerAddress?.trim() ||
    resolveWalletAddressForPublicKeyHash(addresses, withdrawPublicKeyHash) ||
    addresses[0]?.address ||
    addresses[0]?.tokenAddress ||
    ''
  );
}

async function fetchWalletCreatedCauldronPools(
  walletId: number,
  network: Network,
  apiClient = new CauldronApiClient(network)
): Promise<CauldronPool[]> {
  const walletScopedRecords =
    await OutboundTransactionTracker.listAll(walletId);
  let candidates =
    collectWalletCreatedCauldronPoolCandidates(walletScopedRecords);

  if (candidates.length === 0) {
    const allRecords = await OutboundTransactionTracker.listAll(null);
    if (allRecords.length > walletScopedRecords.length) {
      candidates = collectWalletCreatedCauldronPoolCandidates(allRecords);
    }
  }

  if (candidates.length === 0) return [];

  const candidateKeys = new Set(
    candidates.map(
      (candidate) => `${candidate.txHash}:${candidate.outputIndex}`
    )
  );
  const tokenIds = [
    ...new Set(candidates.map((candidate) => candidate.tokenCategory)),
  ];
  const pools = new Map<string, CauldronPool>();

  const rowsByToken = await Promise.allSettled(
    tokenIds.map((tokenId) =>
      fetchNormalizedCauldronPools(network, apiClient, tokenId)
    )
  );

  for (const settled of rowsByToken) {
    if (settled.status !== 'fulfilled') continue;
    for (const pool of settled.value) {
      const selectionId = getPoolSelectionId(pool);
      const candidateKey = `${pool.txHash}:${pool.outputIndex}`;
      if (!candidateKeys.has(candidateKey)) continue;
      if (!pools.has(selectionId)) {
        pools.set(selectionId, pool);
      }
    }
  }

  return [...pools.values()];
}

function dedupeWalletAddressEntries(
  addresses: Array<{ address: string; tokenAddress?: string }>
): Array<{ address: string; tokenAddress?: string }> {
  const byAddress = new Map<
    string,
    { address: string; tokenAddress?: string }
  >();
  for (const entry of addresses) {
    if (!entry.address) continue;
    const key = entry.address.trim().toLowerCase();
    if (!key) continue;
    if (!byAddress.has(key)) {
      byAddress.set(key, {
        address: entry.address,
        tokenAddress: entry.tokenAddress,
      });
    }
  }
  return [...byAddress.values()];
}

function parseApyPercent(
  value: CauldronAggregatedApyResponse['apy']
): string | null {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `${value.toFixed(2)}%`;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? `${trimmed}%` : null;
  }
  return null;
}

function poolToWalletPosition(
  pool: CauldronPool,
  detectionSource: CauldronWalletPoolPosition['detectionSource'] = 'owner_pkh'
): CauldronWalletPoolPosition {
  return {
    pool,
    ownerAddress: pool.ownerAddress ?? null,
    matchingNftUtxos: [],
    hasMatchingTokenNft: false,
    detectionSource,
  };
}

function formatPercentValue(value: number): string {
  if (!Number.isFinite(value)) return '0.00%';
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function formatUnsignedPercentValue(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0.00%';
  return `${value.toFixed(2)}%`;
}

type DerivedPoolHistoryStats = {
  sampleSize: number;
  grossYieldPercent: string | null;
  bchReserveChange: bigint | null;
  tokenReserveChange: bigint | null;
};

function derivePoolHistoryStats(
  history: CauldronPoolHistoryResponse | null
): DerivedPoolHistoryStats {
  const entries = history?.history ?? [];
  if (entries.length < 2) {
    return {
      sampleSize: entries.length,
      grossYieldPercent: null,
      bchReserveChange: null,
      tokenReserveChange: null,
    };
  }

  const start = entries[0];
  const end = entries[entries.length - 1];
  const startSats = Number(start.sats);
  const endSats = Number(end.sats);
  const startTokens = Number(start.tokens);
  const endTokens = Number(end.tokens);

  let grossYieldPercent: string | null = null;
  if (startSats > 0 && endSats > 0 && startTokens > 0 && endTokens > 0) {
    const grossYield =
      Math.sqrt((endSats / startSats) * (endTokens / startTokens)) - 1;
    if (Number.isFinite(grossYield)) {
      grossYieldPercent = formatPercentValue(grossYield * 100);
    }
  }

  return {
    sampleSize: entries.length,
    grossYieldPercent,
    bchReserveChange: parseSatoshis(end.sats) - parseSatoshis(start.sats),
    tokenReserveChange: parseSatoshis(end.tokens) - parseSatoshis(start.tokens),
  };
}

async function buildTradeWithFunding(params: {
  walletId: number;
  allUtxos: UTXO[];
  trades: CauldronPoolTrade[];
  direction: SwapDirection;
  selectedTokenId: string;
  recipientAddress: string;
  changeAddress: string;
  tokenChangeAddress?: string;
  feeRate: bigint;
  userPrompt: string;
}) {
  const {
    walletId,
    allUtxos,
    trades,
    direction,
    selectedTokenId,
    recipientAddress,
    changeAddress,
    tokenChangeAddress,
    feeRate,
    userPrompt,
  } = params;

  const walletKeys = await KeyService.retrieveKeys(walletId);
  const quantumrootVaults =
    await KeyService.retrieveQuantumrootVaults(walletId);
  const allowedWalletAddresses = new Set(
    walletKeys.flatMap((key) =>
      [key.address, key.tokenAddress].filter((address): address is string =>
        Boolean(address)
      )
    )
  );
  for (const vault of quantumrootVaults) {
    if (vault.receive_address)
      allowedWalletAddresses.add(vault.receive_address);
    if (vault.quantum_lock_address) {
      allowedWalletAddresses.add(vault.quantum_lock_address);
    }
  }
  const signableUtxos = allUtxos.filter(
    (utxo) =>
      allowedWalletAddresses.has(utxo.address) ||
      (utxo.tokenAddress != null &&
        allowedWalletAddresses.has(utxo.tokenAddress))
  );

  const sortedBchUtxos = selectLargestBchUtxos(signableUtxos);

  logCauldronTxPlan('trade-build', {
    direction,
    selectedTokenId,
    walletInputCandidates: signableUtxos.length,
    bchCandidateCount: sortedBchUtxos.length,
    tradeCount: trades.length,
    tokenSupply: trades
      .reduce((sum, trade) => sum + trade.supply, 0n)
      .toString(),
    tokenDemand: trades
      .reduce((sum, trade) => sum + trade.demand, 0n)
      .toString(),
    feeRate: feeRate.toString(),
  });

  if (direction === 'bch_to_token') {
    for (let i = 1; i <= sortedBchUtxos.length; i += 1) {
      const selected = sortedBchUtxos.slice(0, i);
      try {
        const walletInputs = await resolveCauldronFundingInputs(
          walletId,
          selected
        );
        return buildCauldronTradeRequest({
          poolTrades: trades,
          walletInputs,
          recipientAddress,
          changeAddress,
          tokenChangeAddress,
          feeRateSatsPerByte: feeRate,
          userPrompt,
        });
      } catch {
        // keep expanding
      }
    }
    throw new Error('Not enough BCH UTXOs are available for this swap.');
  }

  const tokenFunding = selectFundingUtxosByToken(
    signableUtxos,
    selectedTokenId,
    trades.reduce((sum, trade) => sum + trade.supply, 0n)
  );
  logCauldronTxPlan('token-funding-selection', {
    selectedTokenId,
    selectedCount: tokenFunding.selected.length,
    candidateCount: tokenFunding.candidateCount,
    totalAvailable: tokenFunding.totalAvailable.toString(),
    selectedOutpoints: tokenFunding.selected.map(
      (utxo) => `${utxo.tx_hash}:${utxo.tx_pos}`
    ),
    selectedBchBacking: tokenFunding.selected.map((utxo) =>
      parseSatoshis(utxo.amount ?? utxo.value ?? 0).toString()
    ),
    requiredTokenAmount: trades
      .reduce((sum, trade) => sum + trade.supply, 0n)
      .toString(),
  });
  if (tokenFunding.selected.length === 0) {
    throw new Error(
      `Not enough token UTXOs are available for this swap. Available ${formatTokenAmount(
        tokenFunding.totalAvailable,
        0
      )} atoms across ${tokenFunding.candidateCount} UTXOs.`
    );
  }

  for (let extraBch = 0; extraBch <= sortedBchUtxos.length; extraBch += 1) {
    const selected = [
      ...tokenFunding.selected,
      ...sortedBchUtxos.slice(0, extraBch),
    ];
    try {
      const walletInputs = await resolveCauldronFundingInputs(
        walletId,
        selected
      );
      return buildCauldronTradeRequest({
        poolTrades: trades,
        walletInputs,
        recipientAddress,
        changeAddress,
        tokenChangeAddress,
        feeRateSatsPerByte: feeRate,
        userPrompt,
      });
    } catch (error) {
      logCauldronTxPlan('trade-build-failed', {
        extraBch,
        selectedCount: selected.length,
        tokenFundingSelected: tokenFunding.selected.length,
        bchSelectedCount: sortedBchUtxos.slice(0, extraBch).length,
        error: getErrorMessage(error),
      });
      // keep expanding
    }
  }

  throw new Error(
    'Not enough BCH value is attached to token funding inputs to cover network fees.'
  );
}

async function buildPoolDepositWithFunding(params: {
  walletId: number;
  allUtxos: UTXO[];
  tokenCategoryHex: string;
  tokenAmount: bigint;
  bchAmountSatoshis: bigint;
  ownerAddress: string;
  changeAddress: string;
  withdrawPublicKeyHash: Uint8Array;
  feeRate: bigint;
  userPrompt: string;
}) {
  const {
    walletId,
    allUtxos,
    tokenCategoryHex,
    tokenAmount,
    bchAmountSatoshis,
    ownerAddress,
    changeAddress,
    withdrawPublicKeyHash,
    feeRate,
    userPrompt,
  } = params;

  const walletKeys = await KeyService.retrieveKeys(walletId);
  const quantumrootVaults =
    await KeyService.retrieveQuantumrootVaults(walletId);
  const allowedWalletAddresses = new Set(
    walletKeys.flatMap((key) =>
      [key.address, key.tokenAddress].filter((address): address is string =>
        Boolean(address)
      )
    )
  );
  for (const vault of quantumrootVaults) {
    if (vault.receive_address)
      allowedWalletAddresses.add(vault.receive_address);
    if (vault.quantum_lock_address) {
      allowedWalletAddresses.add(vault.quantum_lock_address);
    }
  }
  const signableUtxos = allUtxos.filter(
    (utxo) =>
      allowedWalletAddresses.has(utxo.address) ||
      (utxo.tokenAddress != null &&
        allowedWalletAddresses.has(utxo.tokenAddress))
  );

  const tokenFunding = selectFundingUtxosByToken(
    signableUtxos,
    tokenCategoryHex,
    tokenAmount
  );

  if (tokenFunding.selected.length === 0) {
    throw new Error(
      `Not enough token UTXOs are available for this pool. Available ${formatTokenAmount(
        tokenFunding.totalAvailable,
        0
      )} atoms across ${tokenFunding.candidateCount} UTXOs.`
    );
  }

  const tokenFundingKeys = new Set(
    tokenFunding.selected.map((utxo) => `${utxo.tx_hash}:${utxo.tx_pos}`)
  );
  const sortedBchUtxos = selectLargestBchUtxos(signableUtxos).filter(
    (utxo) => !tokenFundingKeys.has(`${utxo.tx_hash}:${utxo.tx_pos}`)
  );

  logCauldronTxPlan('pool-create-build', {
    tokenCategoryHex,
    tokenAmount: tokenAmount.toString(),
    bchAmountSatoshis: bchAmountSatoshis.toString(),
    walletInputCandidates: signableUtxos.length,
    tokenFundingCandidates: tokenFunding.candidateCount,
    tokenFundingSelected: tokenFunding.selected.length,
    bchCandidateCount: sortedBchUtxos.length,
    feeRate: feeRate.toString(),
  });

  for (let extraBch = 0; extraBch <= sortedBchUtxos.length; extraBch += 1) {
    const selected = [
      ...tokenFunding.selected,
      ...sortedBchUtxos.slice(0, extraBch),
    ];
    try {
      const walletInputs = await resolveCauldronFundingInputs(
        walletId,
        selected
      );
      return buildCauldronPoolDepositRequest({
        walletInputs,
        withdrawPublicKeyHash,
        tokenCategoryHex,
        tokenAmount,
        bchAmountSatoshis,
        ownerAddress,
        changeAddress,
        feeRateSatsPerByte: feeRate,
        userPrompt,
      });
    } catch (error) {
      logCauldronTxPlan('pool-create-build-failed', {
        extraBch,
        selectedCount: selected.length,
        tokenFundingSelected: tokenFunding.selected.length,
        bchSelectedCount: sortedBchUtxos.slice(0, extraBch).length,
        error: getErrorMessage(error),
      });
      // keep expanding BCH support
    }
  }

  throw new Error('Not enough BCH is available to create this pool.');
}

async function buildPoolWithdrawWithFunding(params: {
  walletId: number;
  allUtxos: UTXO[];
  pool: CauldronPool;
  ownerAddress: string;
  recipientAddress: string;
  feeRate: bigint;
  userPrompt: string;
}) {
  const {
    walletId,
    allUtxos,
    pool,
    ownerAddress,
    recipientAddress,
    feeRate,
    userPrompt,
  } = params;

  const walletKeys = await KeyService.retrieveKeys(walletId);
  const quantumrootVaults =
    await KeyService.retrieveQuantumrootVaults(walletId);
  const allowedWalletAddresses = new Set(
    walletKeys.flatMap((key) =>
      [key.address, key.tokenAddress].filter((address): address is string =>
        Boolean(address)
      )
    )
  );
  for (const vault of quantumrootVaults) {
    if (vault.receive_address)
      allowedWalletAddresses.add(vault.receive_address);
    if (vault.quantum_lock_address) {
      allowedWalletAddresses.add(vault.quantum_lock_address);
    }
  }
  const signableUtxos = allUtxos.filter(
    (utxo) =>
      allowedWalletAddresses.has(utxo.address) ||
      (utxo.tokenAddress != null &&
        allowedWalletAddresses.has(utxo.tokenAddress))
  );

  const ownerBchUtxo = selectWalletBchFundingUtxo(signableUtxos, ownerAddress);

  logCauldronTxPlan('pool-withdraw-build', {
    ownerAddress,
    recipientAddress,
    walletInputCandidates: signableUtxos.length,
    ownerBchFound: Boolean(ownerBchUtxo),
    feeRate: feeRate.toString(),
  });

  if (!ownerBchUtxo) {
    throw new Error(
      `No BCH funding UTXO was found for the pool owner address (${ownerAddress}).`
    );
  }

  try {
    const [ownerInput] = await resolveCauldronFundingInputs(walletId, [
      ownerBchUtxo,
    ]);
    return buildCauldronPoolWithdrawRequest({
      pool,
      ownerInput,
      recipientAddress,
      feeRateSatsPerByte: feeRate,
      userPrompt,
    });
  } catch (error) {
    logCauldronTxPlan('pool-withdraw-build-failed', {
      ownerAddress,
      feeRate: feeRate.toString(),
      error: getErrorMessage(error),
    });
    throw error;
  }
}

const CauldronSwapApp: React.FC<CauldronSwapAppProps> = ({ sdk, app }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const backTarget = getReturnPath(location, '/apps');
  const currentNetwork = useSelector((state: RootState) =>
    selectCurrentNetwork(state)
  );
  const walletContext = sdk.wallet.getContext();

  const [tokens, setTokens] = useState<NormalizedCauldronToken[]>([]);
  const [pools, setPools] = useState<CauldronPool[]>([]);
  const [livePools, setLivePools] = useState<CauldronPool[]>([]);
  const [selectedTokenId, setSelectedTokenId] = useState<string>('');
  const [tokenPickerOpen, setTokenPickerOpen] = useState(false);
  const [tokenSearchQuery, setTokenSearchQuery] = useState('');
  const [activeView, setActiveView] = useState<CauldronView>('swap');
  const [direction, setDirection] = useState<SwapDirection>('bch_to_token');
  const [amount, setAmount] = useState<string>('0.001');
  const [slippageBps, setSlippageBps] = useState<string>('100');
  const [loading, setLoading] = useState(true);
  const [quoting, setQuoting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [quote, setQuote] = useState<QuoteState | null>(null);
  const [selectedTokenSpotPriceSats, setSelectedTokenSpotPriceSats] = useState<
    number | null
  >(null);
  const [quoteDetailsOpen, setQuoteDetailsOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewWarningsAccepted, setReviewWarningsAccepted] = useState(false);
  const [poolReview, setPoolReview] = useState<PoolReviewState | null>(null);
  const [withdrawConfirmOpen, setWithdrawConfirmOpen] = useState(false);
  const [broadcastNotice, setBroadcastNotice] = useState<{
    title: string;
    subtitle: string;
    txid?: string | null;
    kind: 'broadcasting' | 'submitted' | 'error';
  } | null>(null);
  const [walletPoolPositions, setWalletPoolPositions] = useState<
    CauldronWalletPoolPosition[]
  >([]);
  const [walletPoolsRefreshing, setWalletPoolsRefreshing] = useState(false);
  const [pendingWalletPoolPositions, setPendingWalletPoolPositions] = useState<
    CauldronWalletPoolPosition[]
  >([]);
  const [suppressedWalletPoolIds, setSuppressedWalletPoolIds] = useState<
    string[]
  >([]);
  const [selectedWalletPoolId, setSelectedWalletPoolId] = useState<
    string | null
  >(null);
  const [selectedWalletPoolHistory, setSelectedWalletPoolHistory] =
    useState<CauldronPoolHistoryResponse | null>(null);
  const [selectedWalletPoolApy, setSelectedWalletPoolApy] = useState<
    string | null
  >(null);
  const selectedTokenManualRef = useRef(false);
  const [loadingWalletPoolHistory, setLoadingWalletPoolHistory] =
    useState(false);
  const [poolCreateBchAmount, setPoolCreateBchAmount] = useState('0.01');
  const [poolCreateTokenAmount, setPoolCreateTokenAmount] = useState('');
  const [poolTokenAmountAuto, setPoolTokenAmountAuto] = useState(true);
  const [poolSyncAnchor, setPoolSyncAnchor] = useState<'bch' | 'token'>('bch');
  const [walletUtxos, setWalletUtxos] = useState<UTXO[]>([]);
  const [walletAddresses, setWalletAddresses] = useState<
    Array<{ address: string; tokenAddress?: string }>
  >([]);
  const { contentClassName } = useSmoothResetTransition();
  const pendingWalletPoolPositionsRef = useRef<CauldronWalletPoolPosition[]>(
    []
  );
  const [apiStatus, setApiStatus] = useState<{
    tokensLoaded: number;
    poolsLoaded: number;
    tokenSource: 'api' | 'pools' | 'mixed';
    liveUpdatesEnabled: boolean;
    liveUpdatedAt: number | null;
  } | null>(null);
  const pendingWalletPoolsStorageKey = useMemo(
    () => getPendingWalletPoolsStorageKey(String(currentNetwork)),
    [currentNetwork]
  );
  const apiClient = useMemo(
    () => new CauldronApiClient(currentNetwork),
    [currentNetwork]
  );

  const showBroadcastNotice = (
    title: string,
    subtitle: string,
    kind: 'broadcasting' | 'submitted' | 'error' = 'broadcasting',
    txid?: string | null
  ) => {
    setBroadcastNotice({
      title,
      subtitle,
      kind,
      txid,
    });
  };

  const clearBroadcastNotice = () => {
    setBroadcastNotice(null);
  };
  const walletPoolsStorageKey = useMemo(
    () => getWalletPoolsStorageKey(String(currentNetwork)),
    [currentNetwork]
  );

  useEffect(() => {
    const storage = getCauldronPoolStorage();
    if (!storage) return;
    const restoredWalletPools = deserializeWalletPoolPositions(
      storage.getItem(walletPoolsStorageKey)
    );
    if (restoredWalletPools.length > 0) {
      setWalletPoolPositions(restoredWalletPools);
    }
  }, [walletPoolsStorageKey]);

  useEffect(() => {
    const storage = getCauldronPoolStorage();
    if (!storage) return;
    const restored = deserializePendingWalletPoolPositions(
      storage.getItem(pendingWalletPoolsStorageKey)
    );
    if (restored.length > 0) {
      setPendingWalletPoolPositions(restored);
      pendingWalletPoolPositionsRef.current = restored;
    }
  }, [pendingWalletPoolsStorageKey]);

  useEffect(() => {
    const storage = getCauldronPoolStorage();
    if (!storage) return;
    if (walletPoolPositions.length === 0) {
      storage.removeItem(walletPoolsStorageKey);
      return;
    }
    storage.setItem(
      walletPoolsStorageKey,
      serializeForStorage(serializeWalletPoolPositions(walletPoolPositions))
    );
  }, [walletPoolPositions, walletPoolsStorageKey]);

  useEffect(() => {
    const storage = getCauldronPoolStorage();
    if (!storage) return;
    if (pendingWalletPoolPositions.length === 0) {
      storage.removeItem(pendingWalletPoolsStorageKey);
      pendingWalletPoolPositionsRef.current = [];
      return;
    }
    storage.setItem(
      pendingWalletPoolsStorageKey,
      serializeForStorage(
        serializePendingWalletPoolPositions(pendingWalletPoolPositions)
      )
    );
    pendingWalletPoolPositionsRef.current = pendingWalletPoolPositions;
  }, [pendingWalletPoolPositions, pendingWalletPoolsStorageKey]);

  const feeRate = 2n;
  const quoteActionsDisabled = false;
  const amountInputRef = useRef<HTMLInputElement | null>(null);
  const selectedToken = useMemo(
    () => tokens.find((token) => token.tokenId === selectedTokenId) ?? null,
    [tokens, selectedTokenId]
  );
  const tokenById = useMemo(
    () => new Map(tokens.map((token) => [token.tokenId, token] as const)),
    [tokens]
  );

  useEffect(() => {
    setSelectedTokenId('');
    setQuote(null);
    setSelectedTokenSpotPriceSats(null);
    setPoolReview(null);
    setWithdrawConfirmOpen(false);
    setSelectedWalletPoolId(null);
    setSelectedWalletPoolHistory(null);
    setSelectedWalletPoolApy(null);
    selectedTokenManualRef.current = false;
  }, [currentNetwork]);
  const createOwnerAddress = useMemo(
    () =>
      walletAddresses[0]?.address || walletAddresses[0]?.tokenAddress || null,
    [walletAddresses]
  );
  const createWithdrawPublicKeyHash = useMemo(() => {
    if (!createOwnerAddress) return null;
    try {
      return derivePublicKeyHash(createOwnerAddress);
    } catch {
      return null;
    }
  }, [createOwnerAddress]);
  const createPoolLockingBytecode = useMemo(() => {
    if (!createWithdrawPublicKeyHash) return null;
    return buildCauldronPoolV0LockingBytecode({
      withdrawPublicKeyHash: createWithdrawPublicKeyHash,
    });
  }, [createWithdrawPublicKeyHash]);
  const metadataCategories = useMemo(
    () =>
      Array.from(
        new Set(
          [
            selectedTokenId,
            ...tokens.map((token) => token.tokenId),
            ...walletPoolPositions.map(
              (position) => position.pool.output.tokenCategory
            ),
          ].filter(Boolean)
        )
      ),
    [selectedTokenId, tokens, walletPoolPositions]
  );
  const sharedMetadata = useSharedTokenMetadata(metadataCategories);

  useEffect(() => {
    if (!message) return undefined;

    const timeoutId = window.setTimeout(() => {
      setMessage((current) => (current === message ? null : current));
    }, CAULDRON_MESSAGE_AUTO_DISMISS_MS);

    return () => window.clearTimeout(timeoutId);
  }, [message]);

  const deferredTokenSearchQuery = useDeferredValue(tokenSearchQuery);
  const filteredTokens = useMemo(() => {
    const query = deferredTokenSearchQuery.trim();
    if (!query) return tokens;

    return [...tokens]
      .map((token) => {
        const metadata = sharedMetadata[token.tokenId];
        const symbol = metadata?.symbol || token.symbol;
        const name = metadata?.name || token.name;
        return {
          token,
          score: fuzzyTokenMatchScore(query, symbol, name),
          symbol,
          name,
        };
      })
      .filter((entry) => entry.score >= 0)
      .sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        if (right.token.tvlSats !== left.token.tvlSats) {
          return right.token.tvlSats - left.token.tvlSats;
        }
        return left.symbol.localeCompare(right.symbol);
      })
      .map((entry) => entry.token);
  }, [deferredTokenSearchQuery, sharedMetadata, tokens]);
  const selectedMetadata = selectedTokenId
    ? sharedMetadata[selectedTokenId]
    : undefined;

  useEffect(() => {
    let cancelled = false;

    setWalletPoolsRefreshing(true);

    void (async () => {
      try {
        const [addresses, walletUtxos, cauldronAddresses] = await Promise.all([
          sdk.wallet.listAddresses(),
          sdk.utxos.listForWallet(),
          fetchCauldronDerivedWalletAddresses(
            walletContext.walletId,
            currentNetwork
          ),
        ]);
        const discoveryAddresses = dedupeWalletAddressEntries([
          ...addresses,
          ...cauldronAddresses,
        ]);
        setWalletAddresses(discoveryAddresses);
        const walletNftTokenIds = [
          ...new Set(
            walletUtxos.tokenUtxos
              .filter((utxo) => Boolean(utxo.token?.nft))
              .map((utxo) => utxo.token?.category?.toLowerCase())
              .filter((tokenId): tokenId is string => Boolean(tokenId))
          ),
        ];
        const nftCandidatePoolsPromise =
          walletNftTokenIds.length === 0
            ? Promise.resolve<CauldronPool[][]>([])
            : Promise.allSettled(
                walletNftTokenIds.map((tokenId) =>
                  fetchNormalizedCauldronPools(
                    currentNetwork,
                    apiClient,
                    tokenId
                  )
                )
              ).then((results) =>
                results.flatMap((result) =>
                  result.status === 'fulfilled' ? [result.value] : []
                )
              );
        const [userPools, walletCreatedPools, nftCandidatePools] =
          await Promise.all([
            fetchNormalizedCauldronUserPools(
              currentNetwork,
              discoveryAddresses,
              apiClient
            ),
            fetchWalletCreatedCauldronPools(
              walletContext.walletId,
              currentNetwork,
              apiClient
            ),
            nftCandidatePoolsPromise,
          ]);
        const persistedCreatedPoolPositions =
          loadCreatedWalletPoolPositions(currentNetwork);
        const storedWalletPoolPositions =
          loadWalletPoolPositionsFromStorage(currentNetwork);
        const createdPoolParameterMap =
          buildCreatedPoolParametersByLockingBytecode([
            ...walletCreatedPools,
            ...persistedCreatedPoolPositions,
            ...storedWalletPoolPositions,
          ]);
        if (createPoolLockingBytecode && createWithdrawPublicKeyHash) {
          createdPoolParameterMap.set(
            binToHex(createPoolLockingBytecode).toLowerCase(),
            createWithdrawPublicKeyHash
          );
        }
        const createdPoolTokenIds = [
          ...new Set([
            ...collectPoolTokenCategories([
              ...walletCreatedPools,
              ...persistedCreatedPoolPositions,
              ...storedWalletPoolPositions,
            ]),
            ...loadCreatedWalletPoolTokenCategories(currentNetwork),
            ...(selectedTokenId ? [selectedTokenId.toLowerCase()] : []),
          ]),
        ];
        const createdPoolLockingBytecodes = [
          ...new Map(
            [
              ...walletCreatedPools.map((pool) => pool.output.lockingBytecode),
              ...persistedCreatedPoolPositions.map(
                (position) => position.pool.output.lockingBytecode
              ),
              ...storedWalletPoolPositions.map(
                (position) => position.pool.output.lockingBytecode
              ),
              ...loadCreatedWalletPoolLockingBytecodes(currentNetwork),
              ...(createPoolLockingBytecode ? [createPoolLockingBytecode] : []),
            ].map(
              (bytecode) =>
                [binToHex(bytecode).toLowerCase(), bytecode] as const
            )
          ).values(),
        ];
        const liveUserPoolPositions = dedupeWalletPoolPositions(
          userPools.map((pool) => poolToWalletPosition(pool))
        );
        const walletTokenIds = [
          ...new Set(
            walletUtxos.tokenUtxos
              .map((utxo) => utxo.token?.category?.toLowerCase())
              .filter((tokenId): tokenId is string => Boolean(tokenId))
          ),
        ];
        const chainTokenIds = [
          ...new Set([...walletTokenIds, ...createdPoolTokenIds]),
        ];
        const chainDetectedPositions = await fetchWalletOwnedPoolsFromChain({
          sdk,
          lockingBytecodes: createdPoolLockingBytecodes,
          tokenIds: chainTokenIds,
          createdPoolParametersByLockingBytecode: createdPoolParameterMap,
        });
        if (cancelled) return;

        setWalletUtxos(mergeWalletUtxoLists(walletUtxos));

        const poolMap = new Map<string, CauldronPool>();
        [
          ...userPools,
          ...walletCreatedPools,
          ...persistedCreatedPoolPositions.map((position) => position.pool),
          ...nftCandidatePools.flat(),
        ].forEach((pool) => {
          poolMap.set(
            pool.poolId ?? `${pool.txHash}:${pool.outputIndex}`,
            pool
          );
        });

        const detectedPositions = detectCauldronWalletPoolPositions(
          [...poolMap.values()],
          walletUtxos.tokenUtxos
        );
        const createdPositions = dedupeWalletPoolPositions([
          ...walletCreatedPools.map((pool) => poolToWalletPosition(pool)),
          ...persistedCreatedPoolPositions,
        ]);
        const liveWalletPoolPositions = dedupeWalletPoolPositions([
          ...liveUserPoolPositions,
          ...createdPositions,
          ...detectedPositions,
          ...chainDetectedPositions,
          ...pendingWalletPoolPositionsRef.current,
        ]);
        const fallbackWalletPoolPositions = dedupeWalletPoolPositions([
          ...storedWalletPoolPositions.filter(
            (position) =>
              ![
                ...liveWalletPoolPositions.map((item) =>
                  getPoolSelectionId(item.pool)
                ),
              ].includes(getPoolSelectionId(position.pool))
          ),
          ...liveWalletPoolPositions,
        ]);
        const nextWalletPositions =
          liveWalletPoolPositions.length > 0
            ? liveWalletPoolPositions
            : fallbackWalletPoolPositions;
        logCauldronTxPlan('refresh', {
          selectedTokenId: selectedTokenId ?? null,
          walletAddressCount: addresses.length,
          walletPoolCount: nextWalletPositions.length,
          walletCreatedPoolCount: walletCreatedPools.length,
          detectedWalletPoolCount: detectedPositions.length,
          chainDetectedPoolCount: chainDetectedPositions.length,
          poolSeedCount: createdPoolTokenIds.length,
          bytecodeSeedCount: createdPoolLockingBytecodes.length,
        });
        setWalletPoolPositions(
          filterSuppressedWalletPoolPositions(
            nextWalletPositions,
            suppressedWalletPoolIds
          )
        );
        setPendingWalletPoolPositions((current) =>
          current.filter(
            (position) =>
              !suppressedWalletPoolIds.includes(
                getPoolSelectionId(position.pool)
              ) &&
              ![...detectedPositions, ...chainDetectedPositions].some(
                (detected) =>
                  getPoolSelectionId(detected.pool) ===
                  getPoolSelectionId(position.pool)
              )
          )
        );
      } catch {
        if (!cancelled) {
          if (walletPoolPositions.length === 0) {
            setMessage('LP refresh failed. Showing cached pools.');
          }
        }
      } finally {
        if (!cancelled) setWalletPoolsRefreshing(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    apiClient,
    currentNetwork,
    createPoolLockingBytecode,
    createWithdrawPublicKeyHash,
    sdk,
    selectedTokenId,
    suppressedWalletPoolIds,
    walletContext.walletId,
    walletPoolPositions.length,
  ]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        setLoading(true);
        setMessage(null);
        const walletUtxos = await sdk.utxos.listForWallet();
        if (cancelled) return;
        setWalletUtxos(mergeWalletUtxoLists(walletUtxos));
        const walletNftTokenIds = [
          ...new Set(
            walletUtxos.tokenUtxos
              .filter((utxo) => Boolean(utxo.token?.nft))
              .map((utxo) => utxo.token?.category?.toLowerCase())
              .filter((tokenId): tokenId is string => Boolean(tokenId))
          ),
        ];
        const [tokenRows, walletTokenRows] = await Promise.all([
          apiClient.listCachedTokens({
            limit: 500,
            by: 'score',
            order: 'desc',
          }),
          apiClient.listCachedTokensByIds(walletNftTokenIds),
        ]);

        if (cancelled) return;

        const normalizedTokens = [...tokenRows, ...walletTokenRows]
          .map((row) => normalizeCauldronTokenRow(row))
          .filter((row): row is NormalizedCauldronToken => row !== null);
        const mergedTokens = mergeTokenCatalog(normalizedTokens, []);

        setTokens(mergedTokens);
        setApiStatus({
          tokensLoaded: mergedTokens.length,
          poolsLoaded: 0,
          tokenSource: walletTokenRows.length > 0 ? 'mixed' : 'api',
          liveUpdatesEnabled: false,
          liveUpdatedAt: null,
        });
      } catch (error) {
        if (!cancelled) {
          setMessage(
            error instanceof Error
              ? error.message
              : 'Failed to load Cauldron markets'
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [currentNetwork, sdk, apiClient]);

  useEffect(() => {
    let cancelled = false;

    if (!selectedTokenId) {
      setPools([]);
      setLivePools([]);
      return () => {
        cancelled = true;
      };
    }

    setLivePools([]);

    void (async () => {
      try {
        const normalizedPools = await fetchNormalizedCauldronPools(
          currentNetwork,
          apiClient,
          selectedTokenId
        );

        if (cancelled) return;
        setPools(normalizedPools);
        setApiStatus((current) =>
          current
            ? {
                ...current,
                poolsLoaded: normalizedPools.length,
              }
            : current
        );
      } catch (error) {
        if (!cancelled) {
          setPools([]);
          setMessage(
            error instanceof Error
              ? error.message
              : 'Failed to load Cauldron pools'
          );
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [apiClient, currentNetwork, selectedTokenId]);

  useEffect(() => {
    if (pools.length === 0 && walletPoolPositions.length === 0) return;

    setTokens((current) =>
      mergeTokenCatalog(current, [
        ...pools,
        ...walletPoolPositions.map((position) => position.pool),
      ])
    );
  }, [pools, walletPoolPositions]);

  useEffect(() => {
    if (tokens.length === 0) return;
    if (selectedTokenManualRef.current) return;

    const tokenStillAvailable = selectedTokenId
      ? tokens.some((token) => token.tokenId === selectedTokenId)
      : false;
    if (tokenStillAvailable) return;

    setSelectedTokenId(tokens[0].tokenId);
  }, [selectedTokenId, tokens]);

  useEffect(() => {
    let cancelled = false;

    if (!selectedTokenId) {
      setSelectedTokenSpotPriceSats(null);
      return () => {
        cancelled = true;
      };
    }

    void (async () => {
      try {
        setSelectedTokenSpotPriceSats(null);
        const payload = await apiClient.getCurrentPrice(selectedTokenId);
        const price =
          typeof payload.price === 'number'
            ? payload.price
            : typeof payload.price === 'string'
              ? Number(payload.price)
              : NaN;
        if (!cancelled) {
          setSelectedTokenSpotPriceSats(
            Number.isFinite(price) && price > 0 ? price : null
          );
        }
      } catch {
        if (!cancelled) {
          setSelectedTokenSpotPriceSats(null);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [apiClient, currentNetwork, direction, selectedTokenId]);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => Promise<void>) | null = null;

    if (!selectedTokenId) {
      return () => {
        cancelled = true;
      };
    }

    void (async () => {
      try {
        const service = getCauldronSubscriptionService(currentNetwork);
        unsubscribe = await service.subscribe(selectedTokenId, (rows) => {
          if (cancelled) return;

          const normalizedPools = rows
            .map((row) => normalizeCauldronPoolRow(row))
            .filter((pool): pool is CauldronPool => pool !== null);

          setLivePools(normalizedPools);
          setApiStatus((current) =>
            current
              ? {
                  ...current,
                  poolsLoaded:
                    normalizedPools.length > 0
                      ? normalizedPools.length
                      : current.poolsLoaded,
                  liveUpdatesEnabled: true,
                  liveUpdatedAt: Date.now(),
                }
              : current
          );
          setQuote((currentQuote) => {
            if (!currentQuote) return currentQuote;
            setMessage(
              'Live Cauldron pool update received. Refresh the quote before swapping.'
            );
            return null;
          });
        });
      } catch {
        if (!cancelled) {
          setApiStatus((current) =>
            current
              ? {
                  ...current,
                  liveUpdatesEnabled: false,
                }
              : current
          );
        }
      }
    })();

    return () => {
      cancelled = true;
      if (unsubscribe) void unsubscribe();
    };
  }, [currentNetwork, selectedTokenId]);

  const tokenPools = useMemo(
    () =>
      dedupePoolsBySelectionId([...pools, ...livePools]).filter(
        (pool) => pool.output.tokenCategory === selectedTokenId
      ),
    [livePools, pools, selectedTokenId]
  );
  const visibleWalletPoolPositions = useMemo(() => {
    const dedupedWalletPools = dedupeWalletPoolPositionsForDisplay([
      ...walletPoolPositions,
      ...pendingWalletPoolPositions,
    ]);
    if (walletAddresses.length === 0) {
      return filterSuppressedWalletPoolPositions(
        dedupedWalletPools,
        suppressedWalletPoolIds
      );
    }
    return filterSuppressedWalletPoolPositions(
      filterWalletPoolPositionsOwnedByWallet(
        dedupedWalletPools,
        walletAddresses
      ),
      suppressedWalletPoolIds
    );
  }, [
    pendingWalletPoolPositions,
    suppressedWalletPoolIds,
    walletAddresses,
    walletPoolPositions,
  ]);
  const selectedWalletPoolPosition = useMemo(
    () =>
      visibleWalletPoolPositions.find(
        (position) => getPoolSelectionId(position.pool) === selectedWalletPoolId
      ) ?? null,
    [selectedWalletPoolId, visibleWalletPoolPositions]
  );
  const preferredWalletMarketTokenId = useMemo(() => {
    const categories = Array.from(
      new Set(
        visibleWalletPoolPositions
          .map((position) => position.pool.output.tokenCategory.toLowerCase())
          .filter(Boolean)
      )
    );
    return categories[0] ?? null;
  }, [visibleWalletPoolPositions]);

  const effectiveSymbol =
    selectedMetadata?.symbol || selectedToken?.symbol || 'TOKEN';
  const effectiveName =
    selectedMetadata?.name || selectedToken?.name || selectedTokenId;
  const effectiveDecimals =
    selectedMetadata?.decimals ?? selectedToken?.decimals ?? 0;
  const tokenIconUri =
    selectedMetadata?.iconUri || selectedToken?.imageUrl || null;
  const selectedPoolToken = selectedWalletPoolPosition
    ? tokenById.get(selectedWalletPoolPosition.pool.output.tokenCategory) ?? null
    : null;
  const selectedPoolMetadata = selectedWalletPoolPosition
    ? sharedMetadata[selectedWalletPoolPosition.pool.output.tokenCategory]
    : undefined;
  const selectedPoolSymbol =
    selectedPoolMetadata?.symbol ||
    selectedPoolToken?.symbol ||
    effectiveSymbol;
  const selectedPoolName =
    selectedPoolMetadata?.name || selectedPoolToken?.name || effectiveName;
  const selectedPoolDecimals =
    selectedPoolMetadata?.decimals ??
    selectedPoolToken?.decimals ??
    effectiveDecimals;
  const selectedWalletPoolStats = useMemo(
    () => derivePoolHistoryStats(selectedWalletPoolHistory),
    [selectedWalletPoolHistory]
  );
  const segmentedBaseClass =
    'rounded-2xl px-4 py-3 text-sm font-semibold transition';
  const fieldClass =
    'w-full rounded-2xl border px-4 py-3 text-sm wallet-text-strong outline-none transition';
  const fieldStyle: React.CSSProperties = {
    backgroundColor: 'var(--wallet-surface)',
    borderColor: 'var(--wallet-border)',
  };
  const activeSegmentStyle: React.CSSProperties = {
    background: 'var(--wallet-btn-primary-bg)',
    color: '#ffffff',
    boxShadow: 'var(--wallet-shadow-btn)',
  };
  const inactiveSegmentStyle: React.CSSProperties = {
    backgroundColor: 'var(--wallet-segment-inactive-bg)',
    color: 'var(--wallet-segment-inactive-text)',
    border: '1px solid var(--wallet-border)',
  };

  useEffect(() => {
    setPoolTokenAmountAuto(true);
    setPoolSyncAnchor('bch');
  }, [selectedTokenId]);

  useEffect(() => {
    if (!preferredWalletMarketTokenId) return;
    if (selectedTokenManualRef.current) return;
    if (selectedTokenId === preferredWalletMarketTokenId) return;
    setSelectedTokenId(preferredWalletMarketTokenId);
    setQuote(null);
    setSelectedTokenSpotPriceSats(null);
  }, [preferredWalletMarketTokenId, selectedTokenId]);

  useEffect(() => {
    if (
      !walletPoolsRefreshing &&
      selectedWalletPoolId &&
      !visibleWalletPoolPositions.some(
        (position) => getPoolSelectionId(position.pool) === selectedWalletPoolId
      )
    ) {
      setSelectedWalletPoolId(null);
      setSelectedWalletPoolHistory(null);
    }
  }, [selectedWalletPoolId, visibleWalletPoolPositions, walletPoolsRefreshing]);

  useEffect(() => {
    let cancelled = false;
    const selectedWalletPoolHistoryId =
      selectedWalletPoolPosition?.historyPoolId ??
      selectedWalletPoolPosition?.pool.poolId ??
      null;

    if (!selectedWalletPoolId || !selectedWalletPoolHistoryId) {
      setSelectedWalletPoolHistory(null);
      setSelectedWalletPoolApy(null);
      return () => {
        cancelled = true;
      };
    }

    void (async () => {
      try {
        setLoadingWalletPoolHistory(true);
        const history = await apiClient.getPoolHistory(
          selectedWalletPoolHistoryId
        );
        const apyResponse = await apiClient
          .getAggregatedApy({
            poolId: selectedWalletPoolHistoryId,
            tokenId: history.token_id,
            publicKeyHash: history.owner_pkh,
          })
          .catch(() => null);

        if (!cancelled) {
          setSelectedWalletPoolHistory(history);
          setSelectedWalletPoolApy(parseApyPercent(apyResponse?.apy));
        }
      } catch {
        if (!cancelled) {
          setSelectedWalletPoolHistory(null);
          setSelectedWalletPoolApy(null);
        }
      } finally {
        if (!cancelled) setLoadingWalletPoolHistory(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [apiClient, currentNetwork, selectedWalletPoolId, selectedWalletPoolPosition]);

  const parsedAmount = useMemo(
    () =>
      direction === 'bch_to_token'
        ? parseBchInputToSats(amount)
        : parseDecimalToAtomic(amount, effectiveDecimals),
    [amount, direction, effectiveDecimals]
  );
  const parsedPoolCreateBchAmount = useMemo(
    () => parseBchInputToSats(poolCreateBchAmount),
    [poolCreateBchAmount]
  );
  const parsedPoolCreateTokenAmount = useMemo(
    () => parseDecimalToAtomic(poolCreateTokenAmount, effectiveDecimals),
    [effectiveDecimals, poolCreateTokenAmount]
  );
  const spendableBchBalanceSats = useMemo(
    () => sumSpendableBchBalance(walletUtxos),
    [walletUtxos]
  );
  const spendableTokenBalanceAtomic = useMemo(
    () =>
      selectedTokenId
        ? sumSpendableTokenBalance(walletUtxos, selectedTokenId)
        : 0n,
    [selectedTokenId, walletUtxos]
  );
  const swapBchMaxInputSats =
    spendableBchBalanceSats > 2_000n ? spendableBchBalanceSats - 2_000n : 0n;
  const poolBchMaxInputSats =
    spendableBchBalanceSats > 2_500n ? spendableBchBalanceSats - 2_500n : 0n;
  const uncappedAutoPoolTokenAmount = useMemo(
    () =>
      derivePoolTokenAmountFromSpotPrice({
        bchAmountSats: parsedPoolCreateBchAmount,
        tokenSpotPriceSats: selectedTokenSpotPriceSats,
        decimals: effectiveDecimals,
      }),
    [effectiveDecimals, parsedPoolCreateBchAmount, selectedTokenSpotPriceSats]
  );
  const autoPoolTokenAmount = useMemo(
    () =>
      derivePoolTokenAmountFromSpotPrice({
        bchAmountSats: parsedPoolCreateBchAmount,
        tokenSpotPriceSats: selectedTokenSpotPriceSats,
        decimals: effectiveDecimals,
        maxTokenAmountAtomic: spendableTokenBalanceAtomic,
      }),
    [
      effectiveDecimals,
      parsedPoolCreateBchAmount,
      selectedTokenSpotPriceSats,
      spendableTokenBalanceAtomic,
    ]
  );
  const autoPoolTokenAmountWasCapped =
    Boolean(uncappedAutoPoolTokenAmount) &&
    uncappedAutoPoolTokenAmount !== autoPoolTokenAmount;
  const autoPoolBchAmount = useMemo(
    () =>
      derivePoolBchAmountFromSpotPrice({
        tokenAmountAtomic: parsedPoolCreateTokenAmount,
        tokenSpotPriceSats: selectedTokenSpotPriceSats,
        maxBchAmountSats: poolBchMaxInputSats,
      }),
    [
      parsedPoolCreateTokenAmount,
      poolBchMaxInputSats,
      selectedTokenSpotPriceSats,
    ]
  );
  const parsedAutoPoolBchAmount = useMemo(
    () => parseBchInputToSats(autoPoolBchAmount),
    [autoPoolBchAmount]
  );
  const autoPoolBchAmountWasCapped = Boolean(
    parsedPoolCreateTokenAmount &&
      parsedPoolCreateTokenAmount > 0n &&
      parsedAutoPoolBchAmount != null &&
      parsedAutoPoolBchAmount >= poolBchMaxInputSats &&
      poolBchMaxInputSats > 0n &&
      selectedTokenSpotPriceSats != null
  );
  const previewState = useMemo(() => {
    if (
      !selectedTokenId ||
      !parsedAmount ||
      parsedAmount <= 0n ||
      tokenPools.length === 0
    ) {
      return { plan: null, error: null as string | null };
    }

    try {
      const planned =
        planAggregatedTradeForTargetSupply(
          tokenPools,
          direction === 'bch_to_token' ? CAULDRON_NATIVE_BCH : selectedTokenId,
          direction === 'bch_to_token' ? selectedTokenId : CAULDRON_NATIVE_BCH,
          parsedAmount
        ) ?? null;
      return {
        plan: planned
          ? { ...planned, trades: aggregatePoolTrades(planned.trades) }
          : null,
        error: null as string | null,
      };
    } catch (error) {
      return {
        plan: null,
        error:
          error instanceof Error
            ? error.message
            : 'Unable to preview this Cauldron market right now.',
      };
    }
  }, [direction, parsedAmount, selectedTokenId, tokenPools]);
  const previewPlan = previewState.plan;
  const previewError = previewState.error;
  const inputAmountNumber = useMemo(
    () => parseDisplayAmountToNumber(amount),
    [amount]
  );
  const spotPreview = useMemo(() => {
    if (
      !selectedTokenSpotPriceSats ||
      !inputAmountNumber ||
      inputAmountNumber <= 0
    ) {
      return null;
    }
    const tokenAtomsPerUnit = Math.pow(10, Math.max(effectiveDecimals, 0));
    if (!Number.isFinite(tokenAtomsPerUnit) || tokenAtomsPerUnit <= 0) {
      return null;
    }

    if (direction === 'bch_to_token') {
      const supplySats = Number(parsedAmount ?? 0n);
      if (!Number.isFinite(supplySats) || supplySats <= 0) return null;
      return {
        demandDisplay: formatApproxDisplayNumber(
          supplySats / (selectedTokenSpotPriceSats * tokenAtomsPerUnit),
          Math.min(Math.max(effectiveDecimals, 0), 8)
        ),
        rateLabel: `1 ${effectiveSymbol} = ${formatApproxDisplayNumber(
          (selectedTokenSpotPriceSats * tokenAtomsPerUnit) / 100_000_000,
          8
        )} BCH`,
      };
    }

    const receiveSats =
      inputAmountNumber * tokenAtomsPerUnit * selectedTokenSpotPriceSats;
    if (!Number.isFinite(receiveSats) || receiveSats <= 0) return null;
    return {
      demandDisplay: formatApproxDisplayNumber(receiveSats / 100_000_000, 8),
      rateLabel: `1 BCH = ${formatApproxDisplayNumber(
        100_000_000 / (selectedTokenSpotPriceSats * tokenAtomsPerUnit),
        Math.min(Math.max(effectiveDecimals, 0), 8)
      )} ${effectiveSymbol}`,
    };
  }, [
    direction,
    effectiveDecimals,
    effectiveSymbol,
    inputAmountNumber,
    parsedAmount,
    selectedTokenSpotPriceSats,
  ]);
  const payBalanceCaption =
    direction === 'bch_to_token'
      ? 'Bitcoin Cash'
      : selectedMetadata?.name || selectedToken?.name || 'Cauldron token';
  const receiveBalanceCaption =
    direction === 'bch_to_token'
      ? selectedMetadata?.name || selectedToken?.name || 'Cauldron token'
      : 'Bitcoin Cash';
  const totalLpFee = useMemo(
    () =>
      quote
        ? quote.trades.reduce((sum, trade) => sum + trade.tradeFee, 0n)
        : previewPlan
          ? previewPlan.trades.reduce((sum, trade) => sum + trade.tradeFee, 0n)
          : 0n,
    [previewPlan, quote]
  );
  const outputDisplayValue = useMemo(() => {
    const demand = quote?.totalDemand ?? previewPlan?.summary.demand ?? 0n;
    if (demand <= 0n) return spotPreview?.demandDisplay ?? '0';
    return direction === 'bch_to_token'
      ? formatTokenAmount(demand, effectiveDecimals)
      : formatBchAmount(demand);
  }, [direction, effectiveDecimals, previewPlan, quote, spotPreview]);
  const quoteRateLabel = useMemo(() => {
    const totalSupply = quote?.totalSupply ?? previewPlan?.summary.supply ?? 0n;
    const totalDemand = quote?.totalDemand ?? previewPlan?.summary.demand ?? 0n;
    if (totalSupply <= 0n || totalDemand <= 0n)
      return spotPreview?.rateLabel ?? null;
    if (direction === 'bch_to_token') {
      const unitPrice =
        (totalSupply * 10n ** BigInt(effectiveDecimals)) / totalDemand;
      return `1 ${effectiveSymbol} = ${formatCompactBchAmount(unitPrice)}`;
    }
    const unitPrice =
      (totalDemand * 10n ** BigInt(effectiveDecimals)) / totalSupply;
    return `1 BCH = ${formatTokenAmount(unitPrice, effectiveDecimals)} ${effectiveSymbol}`;
  }, [
    direction,
    effectiveDecimals,
    effectiveSymbol,
    previewPlan,
    quote,
    spotPreview,
  ]);
  const visibleMarketLiquidity = useMemo(
    () =>
      selectedTokenId && tokenPools.length > 0
        ? analyzeCauldronMarketLiquidity(tokenPools, selectedTokenId)
        : null,
    [selectedTokenId, tokenPools]
  );
  const maxRoutableBchToToken =
    visibleMarketLiquidity?.bchToToken.maxSupply ?? 0n;
  const maxRoutableTokenToBch =
    visibleMarketLiquidity?.tokenToBch.maxSupply ?? 0n;
  const maxExecutableRouteInput =
    direction === 'bch_to_token'
      ? selectExecutableSwapMaxAtomic({
          walletMaxAtomic: swapBchMaxInputSats,
          routableMaxAtomic: maxRoutableBchToToken,
        })
      : selectExecutableSwapMaxAtomic({
          walletMaxAtomic: spendableTokenBalanceAtomic,
          routableMaxAtomic: maxRoutableTokenToBch,
        });
  const minExecutableRouteInput = useMemo(
    () =>
      visibleMarketLiquidity && tokenPools.length > 0
        ? findMinExecutableRouteAmount({
            pools: tokenPools,
            supplyTokenId:
              direction === 'bch_to_token'
                ? CAULDRON_NATIVE_BCH
                : selectedTokenId,
            demandTokenId:
              direction === 'bch_to_token'
                ? selectedTokenId
                : CAULDRON_NATIVE_BCH,
            maxAmount: maxExecutableRouteInput,
          })
        : 0n,
    [
      direction,
      maxExecutableRouteInput,
      selectedTokenId,
      tokenPools,
      visibleMarketLiquidity,
    ]
  );
  const effectiveAtomicPriceSats = useMemo(() => {
    const totalSupply = quote?.totalSupply ?? previewPlan?.summary.supply ?? 0n;
    const totalDemand = quote?.totalDemand ?? previewPlan?.summary.demand ?? 0n;
    if (totalSupply <= 0n || totalDemand <= 0n) return null;

    if (direction === 'bch_to_token') {
      return Number(totalSupply) / Number(totalDemand);
    }
    return Number(totalDemand) / Number(totalSupply);
  }, [direction, previewPlan, quote]);
  const swapAmountExceedsBalance = Boolean(
    parsedAmount && parsedAmount > 0n && parsedAmount > maxExecutableRouteInput
  );
  const canSwap = Boolean(
    selectedTokenId &&
      parsedAmount &&
      parsedAmount > 0n &&
      !swapAmountExceedsBalance
  );
  const currentSwapMaxInput = maxExecutableRouteInput;
  const poolCreateAmountExceedsBalance = Boolean(
    (parsedPoolCreateBchAmount &&
      parsedPoolCreateBchAmount > 0n &&
      parsedPoolCreateBchAmount > poolBchMaxInputSats) ||
      (parsedPoolCreateTokenAmount &&
        parsedPoolCreateTokenAmount > 0n &&
        parsedPoolCreateTokenAmount > spendableTokenBalanceAtomic)
  );
  const canCreatePool = Boolean(
    selectedTokenId &&
      parsedPoolCreateBchAmount &&
      parsedPoolCreateBchAmount > 0n &&
      parsedPoolCreateTokenAmount &&
      parsedPoolCreateTokenAmount > 0n &&
      !poolCreateAmountExceedsBalance
  );
  const payUnitLabel = direction === 'bch_to_token' ? 'BCH' : effectiveSymbol;
  const receiveUnitLabel =
    direction === 'bch_to_token' ? effectiveSymbol : 'BCH';
  const spendSummary = quote
    ? direction === 'bch_to_token'
      ? formatCompactBchAmount(quote.totalSupply)
      : formatTokenDisplayAmount(
          quote.totalSupply,
          effectiveDecimals,
          effectiveSymbol
        )
    : direction === 'bch_to_token'
      ? formatCompactBchAmount(parsedAmount ?? 0n)
      : formatTokenDisplayAmount(
          parsedAmount ?? 0n,
          effectiveDecimals,
          effectiveSymbol
        );
  const receiveSummary = quote
    ? direction === 'bch_to_token'
      ? formatTokenDisplayAmount(
          quote.totalDemand,
          effectiveDecimals,
          effectiveSymbol
        )
      : formatCompactBchAmount(quote.totalDemand)
    : previewPlan
      ? direction === 'bch_to_token'
        ? formatTokenDisplayAmount(
            previewPlan.summary.demand,
            effectiveDecimals,
            effectiveSymbol
          )
        : formatCompactBchAmount(previewPlan.summary.demand)
      : spotPreview
        ? `${spotPreview.demandDisplay} ${receiveUnitLabel}`
        : `0 ${direction === 'bch_to_token' ? effectiveSymbol : 'BCH'}`;
  const feeRatioBps = quote
    ? estimateBps(
        quote.estimatedFeeSatoshis,
        direction === 'bch_to_token' ? quote.totalSupply : quote.totalDemand
      )
    : 0n;
  const priceImpactLabel = useMemo(() => {
    if (
      !selectedTokenSpotPriceSats ||
      !effectiveAtomicPriceSats ||
      !Number.isFinite(effectiveAtomicPriceSats) ||
      effectiveAtomicPriceSats <= 0
    ) {
      return quote
        ? formatUnsignedPercentValue(Number(feeRatioBps) / 100)
        : 'Get quote';
    }

    const impact =
      Math.abs(effectiveAtomicPriceSats - selectedTokenSpotPriceSats) /
      selectedTokenSpotPriceSats;
    return formatUnsignedPercentValue(impact * 100);
  }, [
    effectiveAtomicPriceSats,
    feeRatioBps,
    quote,
    selectedTokenSpotPriceSats,
  ]);
  const previewTradeCount =
    quote?.trades.length ?? previewPlan?.trades.length ?? 0;
  const previewedRouteRows = quote?.trades ?? [];
  const quoteSafetyBanner = useMemo<CauldronQuoteSafetyBanner | null>(
    () =>
      buildCauldronQuoteSafetyBanner({
        quote: quote
          ? {
              builtAt: quote.builtAt,
              usedCachedPools: quote.usedCachedPools,
              warnings: quote.warnings,
            }
          : null,
        liveUpdatesEnabled: apiStatus?.liveUpdatesEnabled ?? true,
        liveUpdatedAt: apiStatus?.liveUpdatedAt ?? null,
        nowMs: Date.now(),
      }),
    [
      apiStatus?.liveUpdatedAt,
      apiStatus?.liveUpdatesEnabled,
      quote,
    ]
  );
  const quoteReviewWarnings =
    quoteSafetyBanner?.messages ?? quote?.warnings ?? [];
  const reviewWarningsAcceptedNeeded = quoteReviewWarnings.length > 0;
  const quoteRiskSummary = quote
    ? {
        slippageBps: quote.slippageBps,
        marketUsageBps: quote.marketUsageBps,
        routePoolCount: quote.routePoolCount,
        walletInputCount: quote.walletInputCount,
        highSlippage: quote.slippageBps >= SAFETY_HIGH_SLIPPAGE_BPS,
        highLiquidityUsage: quote.marketUsageBps >= SAFETY_LOW_LIQUIDITY_BPS,
      }
    : null;
  const swapPayBalanceLabel =
    direction === 'bch_to_token'
      ? `${formatBchAmount(spendableBchBalanceSats)} BCH`
      : `${formatTokenAmount(spendableTokenBalanceAtomic, effectiveDecimals)} ${effectiveSymbol}`;
  const poolBchBalanceLabel = `${formatBchAmount(spendableBchBalanceSats)} BCH`;
  const poolTokenBalanceLabel = `${formatTokenAmount(spendableTokenBalanceAtomic, effectiveDecimals)} ${effectiveSymbol}`;
  const marketRatioCaption =
    selectedTokenSpotPriceSats &&
    parsedPoolCreateBchAmount &&
    parsedPoolCreateBchAmount > 0n
      ? `Market ratio: ${autoPoolTokenAmount || '0'} ${effectiveSymbol} for ${formatBchAmount(parsedPoolCreateBchAmount)} BCH.${autoPoolTokenAmountWasCapped || autoPoolBchAmountWasCapped ? ' Adjusted to fit balance.' : ''}`
      : selectedTokenSpotPriceSats
        ? 'Set BCH and OPTN fills the token side.'
        : 'Use manual token input.';

  const renderAssetBadge = (
    primaryLabel: string,
    secondaryLabel: string,
    iconUri: string | null,
    fallbackTone: 'bch' | 'token'
  ) => (
    <div className="flex items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-2">
        <div
          className="flex h-7 w-7 items-center justify-center overflow-hidden rounded-full text-xs font-bold text-white"
          style={{
            background:
              fallbackTone === 'bch'
                ? 'linear-gradient(180deg, #28d38f 0%, #179c69 100%)'
                : 'linear-gradient(180deg, #5ca7ff 0%, #3c73d8 100%)',
          }}
        >
          {iconUri ? (
            <img
              src={iconUri}
              alt={primaryLabel}
              className="h-full w-full object-cover"
            />
          ) : (
            primaryLabel.slice(0, 1)
          )}
        </div>
        <span className="truncate text-sm font-semibold wallet-text-strong">
          {primaryLabel}
        </span>
      </div>
      <span className="text-[11px] wallet-muted">{secondaryLabel}</span>
    </div>
  );

  const renderTokenPickerTrigger = (compact = false) => (
    <button
      type="button"
      onClick={() => {
        setTokenSearchQuery('');
        setTokenPickerOpen(true);
      }}
      disabled={loading || submitting || tokens.length === 0}
      className="flex w-full items-center gap-2 rounded-xl border px-3 py-2 text-left transition"
      style={{
        backgroundColor: 'var(--wallet-surface-strong)',
        borderColor: 'var(--wallet-border)',
      }}
    >
      {tokenIconUri ? (
        <img
          src={tokenIconUri}
          alt={effectiveSymbol}
          className="h-7 w-7 rounded-full object-cover"
        />
      ) : (
        <div className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--wallet-accent-soft)] text-xs font-bold wallet-text-strong">
          {effectiveSymbol.slice(0, 1)}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold wallet-text-strong">
          {effectiveSymbol} · {effectiveName}
        </div>
        {!compact && selectedToken?.tvlSats ? (
          <div className="text-xs wallet-muted">
            TVL{' '}
            {formatCompactBchAmount(BigInt(Math.trunc(selectedToken.tvlSats)))}
          </div>
        ) : null}
      </div>
      <span className="text-sm wallet-muted">⌄</span>
    </button>
  );

  const assertSwapAmountWithinBalance = (amountAtomic: bigint) => {
    if (amountAtomic > maxExecutableRouteInput) {
      throw new Error(
        direction === 'bch_to_token'
          ? 'Swap amount exceeds the current routable BCH ceiling.'
          : `Swap amount exceeds the current routable ${effectiveSymbol} ceiling.`
      );
    }
  };

  const assertPoolCreateAmountsWithinBalance = (
    bchAmountSats: bigint,
    tokenAmountAtomic: bigint
  ) => {
    if (bchAmountSats > poolBchMaxInputSats) {
      throw new Error(
        'Pool BCH amount exceeds your spendable BCH balance after the network fee buffer.'
      );
    }
    if (tokenAmountAtomic > spendableTokenBalanceAtomic) {
      throw new Error(
        `Pool ${effectiveSymbol} amount exceeds your available token balance.`
      );
    }
  };

  const syncPoolFromBchAmount = useCallback((nextBchAmount: string) => {
    setPoolCreateBchAmount(nextBchAmount);
    if (!selectedTokenSpotPriceSats || !nextBchAmount.trim()) {
      return;
    }

    const nextBchSats = parseBchInputToSats(nextBchAmount);
    if (!nextBchSats || nextBchSats <= 0n) {
      setPoolCreateTokenAmount('');
      return;
    }

    const nextTokenAmount = derivePoolTokenAmountFromSpotPrice({
      bchAmountSats: nextBchSats,
      tokenSpotPriceSats: selectedTokenSpotPriceSats,
      decimals: effectiveDecimals,
      maxTokenAmountAtomic: spendableTokenBalanceAtomic,
    });
    setPoolCreateTokenAmount(nextTokenAmount);
  }, [effectiveDecimals, selectedTokenSpotPriceSats, spendableTokenBalanceAtomic]);

  const syncPoolFromTokenAmount = useCallback((nextTokenAmount: string) => {
    setPoolCreateTokenAmount(nextTokenAmount);
    if (!selectedTokenSpotPriceSats || !nextTokenAmount.trim()) {
      return;
    }

    const nextTokenAtomic = parseDecimalToAtomic(
      nextTokenAmount,
      effectiveDecimals
    );
    if (!nextTokenAtomic || nextTokenAtomic <= 0n) {
      setPoolCreateBchAmount('');
      return;
    }

    const nextBchAmount = derivePoolBchAmountFromSpotPrice({
      tokenAmountAtomic: nextTokenAtomic,
      tokenSpotPriceSats: selectedTokenSpotPriceSats,
      maxBchAmountSats: poolBchMaxInputSats,
    });
    setPoolCreateBchAmount(nextBchAmount);
  }, [effectiveDecimals, poolBchMaxInputSats, selectedTokenSpotPriceSats]);

  useEffect(() => {
    if (!poolTokenAmountAuto) return;
    if (poolSyncAnchor === 'token') {
      syncPoolFromTokenAmount(poolCreateTokenAmount);
      return;
    }
    syncPoolFromBchAmount(poolCreateBchAmount);
  }, [
    autoPoolTokenAmount,
    poolCreateBchAmount,
    poolCreateTokenAmount,
    poolSyncAnchor,
    poolTokenAmountAuto,
    selectedTokenSpotPriceSats,
    syncPoolFromBchAmount,
    syncPoolFromTokenAmount,
  ]);

  const handleQuote = async (): Promise<boolean> => {
    try {
      setQuoting(true);
      setMessage(null);
      setQuote(null);

      if (!selectedTokenId) {
        throw new Error('Pick a Cauldron token first.');
      }
      if (!parsedAmount || parsedAmount <= 0n) {
        throw new Error('Enter a valid amount greater than zero.');
      }
      assertSwapAmountWithinBalance(parsedAmount);
      if (tokenPools.length === 0) {
        throw new Error('No active Cauldron pools were found for this token.');
      }
      if (
        minExecutableRouteInput > 0n &&
        parsedAmount < minExecutableRouteInput
      ) {
        throw new Error(
          `That amount is below the current minimum routable market size. The market currently needs at least ${
            direction === 'bch_to_token'
              ? formatCompactBchAmount(minExecutableRouteInput)
              : formatTokenDisplayAmount(
                  minExecutableRouteInput,
                  effectiveDecimals,
                  effectiveSymbol
                )
          } to build an executable route.`
        );
      }

      let confirmedPools: CauldronPool[] = [];
      let missingVisiblePoolCount = 0;
      let previewUsedCachedPools = false;
      try {
        const resolved = await fetchVisiblePoolsFromChain({
          sdk,
          visiblePools: tokenPools,
        });
        confirmedPools = resolved.confirmedPools;
        missingVisiblePoolCount = resolved.missingVisiblePoolCount;
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        if (message.toLowerCase().includes('rate limit')) {
          confirmedPools = tokenPools;
          previewUsedCachedPools = true;
        } else {
          throw error;
        }
      }
      if (confirmedPools.length === 0) {
        previewUsedCachedPools = true;
        confirmedPools = tokenPools;
        missingVisiblePoolCount = tokenPools.length;
      }

      const marketLiquidity = analyzeCauldronMarketLiquidity(
        confirmedPools,
        selectedTokenId
      );
      const currentDirectionLiquidity =
        direction === 'bch_to_token'
          ? marketLiquidity.bchToToken
          : marketLiquidity.tokenToBch;
      const reverseDirectionLiquidity =
        direction === 'bch_to_token'
          ? marketLiquidity.tokenToBch
          : marketLiquidity.bchToToken;

      const planned = planAggregatedTradeForTargetSupply(
        confirmedPools,
        direction === 'bch_to_token' ? CAULDRON_NATIVE_BCH : selectedTokenId,
        direction === 'bch_to_token' ? selectedTokenId : CAULDRON_NATIVE_BCH,
        parsedAmount
      );
      if (!planned) {
        throw new Error(
          missingVisiblePoolCount > 0
            ? 'The visible Cauldron market changed on chain before this quote could be built. Refresh and try again.'
            : 'No Cauldron quote is currently available for that amount.'
        );
      }
      const aggregatedTrades = aggregatePoolTrades(planned.trades);
      if (aggregatedTrades.length === 0) {
        throw new Error(
          'Cauldron could not build a route with any executable pools for this direction. Refresh and try again.'
        );
      }

      const addresses = await sdk.wallet.listAddresses();
      const primaryAddress =
        direction === 'bch_to_token'
          ? addresses[0]?.tokenAddress || addresses[0]?.address
          : addresses[0]?.address;
      if (!primaryAddress || !addresses[0]?.address) {
        throw new Error('No wallet settlement address is available.');
      }

      const walletUtxos = await sdk.utxos.listForWallet();
      const mergedWalletUtxos = mergeWalletUtxoLists(walletUtxos);
      const built = await buildTradeWithFunding({
        walletId: walletContext.walletId,
        allUtxos: mergedWalletUtxos,
        trades: aggregatedTrades,
        direction,
        selectedTokenId,
        recipientAddress: primaryAddress,
        changeAddress: addresses[0].address,
        tokenChangeAddress: addresses[0].tokenAddress || addresses[0].address,
        feeRate,
        userPrompt:
          direction === 'bch_to_token'
            ? `Cauldron swap ${formatBchAmount(planned.summary.supply)} BCH -> ${effectiveSymbol}`
            : `Cauldron swap ${formatTokenAmount(planned.summary.supply, effectiveDecimals)} ${effectiveSymbol} -> BCH`,
      });

      const slippage = BigInt(slippageBps || '0');
      const warnings: string[] = [];
      if (aggregatedTrades.length > SAFETY_MAX_ROUTE_POOLS) {
        warnings.push(
          `This route uses ${aggregatedTrades.length} pools, which is more complex than a typical swap.`
        );
      }
      if (built.walletInputs.length > SAFETY_MAX_WALLET_INPUTS) {
        warnings.push(
          `This swap will spend ${built.walletInputs.length} wallet inputs. Review the selected coins carefully.`
        );
      }
      if (slippage >= SAFETY_HIGH_SLIPPAGE_BPS) {
        warnings.push(
          `Your slippage setting is ${Number(slippage) / 100}%, which is high for a wallet-confirmed swap.`
        );
      }
      const feeBps = estimateBps(
        built.estimatedFeeSatoshis,
        direction === 'bch_to_token'
          ? planned.summary.supply
          : planned.summary.demand
      );
      if (feeBps >= SAFETY_HIGH_FEE_BPS) {
        warnings.push(
          `Estimated network fee is relatively high for this trade size (${(Number(feeBps) / 100).toFixed(2)}%).`
        );
      }
      const currentLiquidityUsageBps = estimateBps(
        planned.summary.demand,
        currentDirectionLiquidity.maxDemand
      );
      if (currentLiquidityUsageBps >= SAFETY_LOW_LIQUIDITY_BPS) {
        warnings.push(
          formatLiquidityUsageWarning(
            direction === 'bch_to_token' ? 'This buy' : 'This sell',
            currentLiquidityUsageBps
          )
        );
      }
      if (direction === 'bch_to_token') {
        if (reverseDirectionLiquidity.maxSupply <= 0n) {
          warnings.push(
            `Current reverse liquidity is effectively unavailable. If you receive ${formatTokenDisplayAmount(
              planned.summary.demand,
              effectiveDecimals,
              effectiveSymbol
            )}, you may not be able to swap it back to BCH until more liquidity appears.`
          );
        } else if (
          planned.summary.demand > reverseDirectionLiquidity.maxSupply
        ) {
          warnings.push(
            `Current reverse liquidity can only absorb about ${formatTokenDisplayAmount(
              reverseDirectionLiquidity.maxSupply,
              effectiveDecimals,
              effectiveSymbol
            )}. This quote would leave you with more ${effectiveSymbol} than the market can currently swap back to BCH.`
          );
        } else {
          const reverseLiquidityUsageBps = estimateBps(
            planned.summary.demand,
            reverseDirectionLiquidity.maxSupply
          );
          if (reverseLiquidityUsageBps >= SAFETY_LOW_LIQUIDITY_BPS) {
            warnings.push(
              formatLiquidityUsageWarning(
                `Selling back ${formatTokenDisplayAmount(
                  planned.summary.demand,
                  effectiveDecimals,
                  effectiveSymbol
                )}`,
                reverseLiquidityUsageBps
              )
            );
          }
        }
      } else {
        if (reverseDirectionLiquidity.maxSupply <= 0n) {
          warnings.push(
            `Current BCH-to-${effectiveSymbol} liquidity is effectively unavailable. If you exit to BCH now, buying back later may not be possible until liquidity returns.`
          );
        } else if (
          planned.summary.demand > reverseDirectionLiquidity.maxSupply
        ) {
          warnings.push(
            `Current BCH-to-${effectiveSymbol} liquidity can only absorb about ${formatCompactBchAmount(
              reverseDirectionLiquidity.maxSupply
            )}. The BCH from this quote would be larger than the market can currently route back into ${effectiveSymbol}.`
          );
        } else {
          const reverseLiquidityUsageBps = estimateBps(
            planned.summary.demand,
            reverseDirectionLiquidity.maxSupply
          );
          if (reverseLiquidityUsageBps >= SAFETY_LOW_LIQUIDITY_BPS) {
            warnings.push(
              formatLiquidityUsageWarning(
                `Buying back with ${formatCompactBchAmount(planned.summary.demand)}`,
                reverseLiquidityUsageBps
              )
            );
          }
        }
      }
      if (previewUsedCachedPools) {
        warnings.push(
          'Chain confirmation was rate-limited, so this quote used the already-visible pool set. Submit still re-checks chain state before broadcasting.'
        );
      }

      setQuote({
        trades: aggregatedTrades,
        totalSupply: planned.summary.supply,
        totalDemand: planned.summary.demand,
        estimatedFeeSatoshis: built.estimatedFeeSatoshis,
        minReceive: applySlippage(planned.summary.demand, slippage),
        built,
        builtAt: Date.now(),
        usedCachedPools: previewUsedCachedPools,
        slippageBps: slippage,
        marketUsageBps: currentLiquidityUsageBps,
        routePoolCount: aggregatedTrades.length,
        walletInputCount: built.walletInputs.length,
        warnings,
      });
      setReviewWarningsAccepted(false);
      return true;
    } catch (error) {
      const baseMessage =
        error instanceof Error
          ? error.message
          : 'Unable to quote Cauldron swap';
      const classification = classifyCauldronQuoteFailure(baseMessage);
      if (classification.kind === 'no-route' && selectedTokenId) {
        try {
          const marketLiquidity = analyzeCauldronMarketLiquidity(
            tokenPools,
            selectedTokenId
          );
          const currentDirectionLiquidity =
            direction === 'bch_to_token'
              ? marketLiquidity.bchToToken
              : marketLiquidity.tokenToBch;
          setMessage(
            `${baseMessage} The current market can route about ${
              direction === 'bch_to_token'
                ? formatTokenDisplayAmount(
                    currentDirectionLiquidity.maxDemand,
                    effectiveDecimals,
                    effectiveSymbol
                  )
                : formatCompactBchAmount(currentDirectionLiquidity.maxSupply)
            } in this direction right now.`
          );
        } catch {
          setMessage(baseMessage);
        }
        return;
      }
      if (classification.kind === 'minimum') {
        setMessage(classification.message);
        return;
      }
      if (classification.kind === 'market-changed') {
        setMessage(
          `${classification.message} The quote was built from a pool set that no longer matches chain state.`
        );
        return;
      }
      if (classification.kind === 'no-confirmed-pools') {
        setMessage(
          `${classification.message} The direct quote path needs a fresh chain-confirmed pool set to continue.`
        );
        return;
      }
      if (classification.kind === 'rate-limited') {
        setMessage(
          `${classification.message} OPTN fell back to visible pools for preview, but the market could not be fully refreshed right now.`
        );
        return;
      }
      setMessage(baseMessage);
      return false;
    } finally {
      setQuoting(false);
    }
  };

  const handleSwap = async () => {
    try {
      setSubmitting(true);
      setMessage(null);

      if (!quote || !selectedTokenId || !parsedAmount || parsedAmount <= 0n) {
        throw new Error('Refresh the quote before swapping.');
      }
      assertSwapAmountWithinBalance(parsedAmount);

      const { resolvedPools: currentQuotedPools, missingQuotedPoolCount } =
        await fetchCurrentQuotedPoolsFromChain({
          sdk,
          quotedPools: quote.trades.map((trade) => trade.pool),
        });
      if (missingQuotedPoolCount > 0) {
        throw new Error(
          'Cauldron quote expired because one or more reviewed pools changed on chain. Get a fresh quote before submitting.'
        );
      }

      const refreshedPlan = planAggregatedTradeForTargetSupply(
        currentQuotedPools,
        direction === 'bch_to_token' ? CAULDRON_NATIVE_BCH : selectedTokenId,
        direction === 'bch_to_token' ? selectedTokenId : CAULDRON_NATIVE_BCH,
        parsedAmount
      );
      if (!refreshedPlan) {
        throw new Error(
          'Cauldron quote expired against the latest confirmed pool state. Refresh the quote and try again.'
        );
      }
      const aggregatedTrades = aggregatePoolTrades(refreshedPlan.trades);
      if (aggregatedTrades.length === 0) {
        throw new Error(
          'Cauldron could not refresh this route with any executable pools for this direction.'
        );
      }
      if (refreshedPlan.summary.demand < quote.minReceive) {
        throw new Error('The refreshed quote fell below your slippage limit.');
      }

      const addresses = await sdk.wallet.listAddresses();
      const primaryAddress =
        direction === 'bch_to_token'
          ? addresses[0]?.tokenAddress || addresses[0]?.address
          : addresses[0]?.address;
      if (!primaryAddress || !addresses[0]?.address) {
        throw new Error('No wallet settlement address is available.');
      }

      const walletUtxos = await sdk.utxos.listForWallet();
      const mergedWalletUtxos = mergeWalletUtxoLists(walletUtxos);
      const built = await buildTradeWithFunding({
        walletId: walletContext.walletId,
        allUtxos: mergedWalletUtxos,
        trades: aggregatedTrades,
        direction,
        selectedTokenId,
        recipientAddress: primaryAddress,
        changeAddress: addresses[0].address,
        tokenChangeAddress: addresses[0].tokenAddress || addresses[0].address,
        feeRate,
        userPrompt:
          direction === 'bch_to_token'
            ? `Cauldron swap ${formatBchAmount(refreshedPlan.summary.supply)} BCH -> ${effectiveSymbol}`
            : `Cauldron swap ${formatTokenAmount(refreshedPlan.summary.supply, effectiveDecimals)} ${effectiveSymbol} -> BCH`,
      });

      const result = await signAndBroadcastCauldronTradeRequest(
        walletContext.walletId,
        built,
        {
          sourceLabel: 'Cauldron Swap',
          recipientSummary: effectiveName || selectedTokenId,
          amountSummary:
            direction === 'bch_to_token'
              ? `${formatBchAmount(refreshedPlan.summary.supply)} BCH`
              : `${formatTokenAmount(refreshedPlan.summary.supply, effectiveDecimals)} ${effectiveSymbol}`,
          userPrompt: built.signRequest.transaction.userPrompt ?? null,
        }
      );
      if (result.errorMessage) {
        throw new Error(result.errorMessage);
      }

      showBroadcastNotice(
        result.broadcastState === 'submitted'
          ? 'Swap submitted'
          : 'Swap broadcasted',
        result.broadcastState === 'submitted'
          ? `Keeping ${result.txid} under watch while the wallet refreshes in the background.`
          : `Broadcast completed with ${result.txid}.`,
        'submitted',
        result.txid
      );
      setMessage(
        result.broadcastState === 'submitted'
          ? `Swap handoff pending visibility: ${result.txid}. Keep the txid and avoid sending it again until it appears in history.`
          : `Swap broadcasted: ${result.txid}`
      );
      await refreshCauldronState();
      resetCauldronViewState();
    } catch (error) {
      showBroadcastNotice(
        'Swap failed',
        error instanceof Error ? error.message : 'Cauldron swap failed',
        'error'
      );
      setMessage(
        error instanceof Error ? error.message : 'Cauldron swap failed'
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleReviewSwap = () => {
    if (!quote) {
      setMessage('Get a fresh quote before reviewing this swap.');
      return;
    }
    setReviewWarningsAccepted(false);
    setReviewOpen(true);
  };

  const handleQuoteAndOpenDetails = () => {
    void handleQuote().then((success) => {
      if (success) {
        setQuoteDetailsOpen(true);
      }
    });
  };

  const handleConfirmSwapReview = () => {
    setReviewOpen(false);
    void handleSwap();
  };

  const resetSwapComposer = () => {
    setAmount(direction === 'bch_to_token' ? '0.001' : '1');
    setQuote(null);
    setReviewOpen(false);
    setReviewWarningsAccepted(false);
  };

  const resetPoolComposer = () => {
    setPoolCreateBchAmount('0.01');
    setPoolCreateTokenAmount('');
    setPoolReview(null);
    setSelectedWalletPoolId(null);
    setWithdrawConfirmOpen(false);
    setPoolTokenAmountAuto(true);
    setPoolSyncAnchor('bch');
  };

  const resetCauldronViewState = (
    suppressedPoolIds = suppressedWalletPoolIds
  ) => {
    setWalletPoolPositions((current) =>
      filterSuppressedWalletPoolPositions(current, suppressedPoolIds)
    );
    setPendingWalletPoolPositions((current) =>
      filterSuppressedWalletPoolPositions(current, suppressedPoolIds)
    );
    pendingWalletPoolPositionsRef.current = filterSuppressedWalletPoolPositions(
      pendingWalletPoolPositionsRef.current,
      suppressedPoolIds
    );
    resetSwapComposer();
    resetPoolComposer();
    setActiveView('swap');
    setSelectedWalletPoolHistory(null);
    setSelectedWalletPoolApy(null);
    setTokenSearchQuery('');
    clearBroadcastNotice();
  };

  const refreshCauldronState = async (
    suppressedPoolIds = suppressedWalletPoolIds
  ) => {
    setWalletPoolsRefreshing(true);
    try {
      const [addresses, cauldronAddresses] = await Promise.all([
        sdk.wallet.listAddresses(),
        fetchCauldronDerivedWalletAddresses(
          walletContext.walletId,
          currentNetwork
        ),
      ]);
      const discoveryAddresses = dedupeWalletAddressEntries([
        ...addresses,
        ...cauldronAddresses,
      ]);
      await Promise.allSettled(
        addresses.map((entry) => sdk.utxos.refreshAndStore(entry.address))
      );

      const refreshedPoolsPromise = selectedTokenId
        ? fetchNormalizedCauldronPools(
            currentNetwork,
            apiClient,
            selectedTokenId
          )
        : Promise.resolve<CauldronPool[]>([]);
      const walletUtxosPromise = sdk.utxos.listForWallet();
      const userPoolsPromise = fetchNormalizedCauldronUserPools(
        currentNetwork,
        discoveryAddresses,
        apiClient
      );
      const walletCreatedPoolsPromise = fetchWalletCreatedCauldronPools(
        walletContext.walletId,
        currentNetwork,
        apiClient
      );

      const [refreshedPools, walletUtxos, userPools, walletCreatedPools] =
        await Promise.all([
          refreshedPoolsPromise,
          walletUtxosPromise,
          userPoolsPromise,
          walletCreatedPoolsPromise,
        ]);

      if (selectedTokenId) {
        setPools(refreshedPools);
        setLivePools([]);
      }

      setWalletUtxos(mergeWalletUtxoLists(walletUtxos));
      const walletNftTokenIds = [
        ...new Set(
          walletUtxos.tokenUtxos
            .filter((utxo) => Boolean(utxo.token?.nft))
            .map((utxo) => utxo.token?.category?.toLowerCase())
            .filter((tokenId): tokenId is string => Boolean(tokenId))
        ),
      ];
      const nftCandidatePoolsPromise =
        walletNftTokenIds.length === 0
          ? Promise.resolve<CauldronPool[][]>([])
          : Promise.allSettled(
              walletNftTokenIds.map((tokenId) =>
                fetchNormalizedCauldronPools(currentNetwork, apiClient, tokenId)
              )
            ).then((results) =>
              results.flatMap((result) =>
                result.status === 'fulfilled' ? [result.value] : []
              )
            );
      const persistedCreatedPoolPositions =
        loadCreatedWalletPoolPositions(currentNetwork);
      const storedWalletPoolPositions =
        loadWalletPoolPositionsFromStorage(currentNetwork);
      const createdPoolParameterMap =
        buildCreatedPoolParametersByLockingBytecode([
          ...walletCreatedPools,
          ...persistedCreatedPoolPositions,
          ...storedWalletPoolPositions,
        ]);
      if (createPoolLockingBytecode && createWithdrawPublicKeyHash) {
        createdPoolParameterMap.set(
          binToHex(createPoolLockingBytecode).toLowerCase(),
          createWithdrawPublicKeyHash
        );
      }
      const walletTokenIds = [
        ...new Set(
          walletUtxos.tokenUtxos
            .map((utxo) => utxo.token?.category?.toLowerCase())
            .filter((tokenId): tokenId is string => Boolean(tokenId))
        ),
      ];
      const createdPoolTokenIds = [
        ...new Set([
          ...collectPoolTokenCategories([
            ...walletCreatedPools,
            ...persistedCreatedPoolPositions,
            ...storedWalletPoolPositions,
          ]),
          ...loadCreatedWalletPoolTokenCategories(currentNetwork),
          ...(selectedTokenId ? [selectedTokenId.toLowerCase()] : []),
        ]),
      ];
      const createdPoolLockingBytecodes = [
        ...new Map(
          [
            ...walletCreatedPools.map((pool) => pool.output.lockingBytecode),
            ...persistedCreatedPoolPositions.map(
              (position) => position.pool.output.lockingBytecode
            ),
            ...storedWalletPoolPositions.map(
              (position) => position.pool.output.lockingBytecode
            ),
            ...loadCreatedWalletPoolLockingBytecodes(currentNetwork),
            ...(createPoolLockingBytecode ? [createPoolLockingBytecode] : []),
          ].map(
            (bytecode) => [binToHex(bytecode).toLowerCase(), bytecode] as const
          )
        ).values(),
      ];
      const preliminaryWalletPoolPositions = dedupeWalletPoolPositions([
        ...storedWalletPoolPositions.filter(
          (position) =>
            ![
              ...walletCreatedPools.map((pool) => getPoolSelectionId(pool)),
              ...persistedCreatedPoolPositions.map((position) =>
                getPoolSelectionId(position.pool)
              ),
            ].includes(getPoolSelectionId(position.pool))
        ),
        ...walletCreatedPools.map((pool) => poolToWalletPosition(pool)),
        ...persistedCreatedPoolPositions,
      ]);
      setWalletPoolPositions(
        filterSuppressedWalletPoolPositions(
          preliminaryWalletPoolPositions,
          suppressedPoolIds
        )
      );
      const chainTokenIds = [
        ...new Set([...walletTokenIds, ...createdPoolTokenIds]),
      ];
      const [chainDetectedPositions, nftCandidatePools] = await Promise.all([
        fetchWalletOwnedPoolsFromChain({
          sdk,
          lockingBytecodes: createdPoolLockingBytecodes,
          tokenIds: chainTokenIds,
          createdPoolParametersByLockingBytecode: createdPoolParameterMap,
        }),
        nftCandidatePoolsPromise,
      ]);
      const poolMap = new Map<string, CauldronPool>();
      [...userPools, ...nftCandidatePools.flat()].forEach((pool) => {
        poolMap.set(getPoolSelectionId(pool), pool);
      });
      const detectedPositions = detectCauldronWalletPoolPositions(
        [...poolMap.values()],
        walletUtxos.tokenUtxos
      );
      const createdPositions = preliminaryWalletPoolPositions;
      const nextWalletPoolPositions = dedupeWalletPoolPositions([
        ...createdPositions,
        ...detectedPositions,
        ...chainDetectedPositions,
        ...pendingWalletPoolPositionsRef.current,
      ]);
      logCauldronTxPlan('refresh', {
        selectedTokenId: selectedTokenId ?? null,
        walletAddressCount: addresses.length,
        walletPoolCount: nextWalletPoolPositions.length,
        walletCreatedPoolCount: walletCreatedPools.length,
        detectedWalletPoolCount: detectedPositions.length,
        chainDetectedPoolCount: chainDetectedPositions.length,
        poolSeedCount: createdPoolTokenIds.length,
        bytecodeSeedCount: createdPoolLockingBytecodes.length,
      });
      setPoolRefreshTrace({
        createdPoolTokenIds,
        createdPoolLockingBytecodeCount: createdPoolLockingBytecodes.length,
        chainDetectedPoolCount: chainDetectedPositions.length,
      });
      setWalletPoolPositions(
        filterSuppressedWalletPoolPositions(
          nextWalletPoolPositions,
          suppressedPoolIds
        )
      );
      setPendingWalletPoolPositions((current) =>
        current.filter(
          (position) =>
            !suppressedPoolIds.includes(getPoolSelectionId(position.pool)) &&
            ![...detectedPositions, ...chainDetectedPositions].some(
              (detected) =>
                getPoolSelectionId(detected.pool) ===
                getPoolSelectionId(position.pool)
            )
        )
      );
    } finally {
      setWalletPoolsRefreshing(false);
    }
  };

  const handleCreatePool = async () => {
    try {
      setMessage(null);

      if (!selectedTokenId) {
        throw new Error('Pick a Cauldron token before creating a pool.');
      }
      if (!parsedPoolCreateBchAmount || parsedPoolCreateBchAmount <= 0n) {
        throw new Error('Enter a valid BCH amount for the pool.');
      }
      if (!parsedPoolCreateTokenAmount || parsedPoolCreateTokenAmount <= 0n) {
        throw new Error(
          `Enter a valid ${effectiveSymbol} amount for the pool.`
        );
      }
      assertPoolCreateAmountsWithinBalance(
        parsedPoolCreateBchAmount,
        parsedPoolCreateTokenAmount
      );

      const addresses = await sdk.wallet.listAddresses();
      const ownerAddress = addresses[0]?.address || addresses[0]?.tokenAddress;
      const changeAddress = addresses[0]?.address;
      if (!ownerAddress || !changeAddress) {
        throw new Error('No wallet address is available for pool creation.');
      }

      const walletUtxos = await sdk.utxos.listForWallet();
      const mergedWalletUtxos = mergeWalletUtxoLists(walletUtxos);
      const built = await buildPoolDepositWithFunding({
        walletId: walletContext.walletId,
        allUtxos: mergedWalletUtxos,
        tokenCategoryHex: selectedTokenId,
        tokenAmount: parsedPoolCreateTokenAmount,
        bchAmountSatoshis: parsedPoolCreateBchAmount,
        ownerAddress,
        changeAddress,
        withdrawPublicKeyHash: derivePublicKeyHash(ownerAddress),
        feeRate,
        userPrompt: `Create Cauldron pool ${formatBchAmount(parsedPoolCreateBchAmount)} BCH + ${formatTokenAmount(parsedPoolCreateTokenAmount, effectiveDecimals)} ${effectiveSymbol}`,
      });
      setPoolReview({
        kind: 'create',
        built,
        bchAmount: parsedPoolCreateBchAmount,
        tokenAmount: parsedPoolCreateTokenAmount,
        ownerAddress,
      });
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : 'Unable to create Cauldron pool'
      );
    }
  };

  const handleWithdrawPool = async () => {
    try {
      setMessage(null);

      if (!selectedWalletPoolPosition) {
        throw new Error('Select a pool first.');
      }

      const addresses = dedupeWalletAddressEntries([
        ...(await sdk.wallet.listAddresses()),
        ...(await fetchCauldronDerivedWalletAddresses(
          walletContext.walletId,
          currentNetwork
        )),
      ]);
      const ownerAddress = resolvePoolWithdrawalOwnerAddress({
        addresses,
        poolOwnerAddress: selectedWalletPoolPosition.ownerAddress,
        withdrawPublicKeyHash: resolveCauldronPoolWithdrawPublicKeyHash(
          selectedWalletPoolPosition.pool
        ),
      });
      if (!ownerAddress) {
        throw new Error(
          'No wallet address matches this pool owner. Withdraw is not available from this wallet.'
        );
      }

      const recipientAddress =
        addresses[0]?.tokenAddress || addresses[0]?.address || ownerAddress;
      const walletUtxos = await sdk.utxos.listForWallet();
      const mergedWalletUtxos = mergeWalletUtxoLists(walletUtxos);
      const built = await buildPoolWithdrawWithFunding({
        walletId: walletContext.walletId,
        allUtxos: mergedWalletUtxos,
        pool: selectedWalletPoolPosition.pool,
        ownerAddress,
        recipientAddress,
        feeRate,
        userPrompt: `Withdraw Cauldron pool ${selectedPoolName}`,
      });

      setSubmitting(true);
      showBroadcastNotice(
        'Broadcasting pool withdrawal',
        'Preparing the transaction for submission.',
        'broadcasting'
      );

      const result = await signAndBroadcastCauldronPoolWithdrawRequest(
        walletContext.walletId,
        built,
        {
          sourceLabel: 'Cauldron Pool Withdraw',
          recipientSummary: selectedPoolName,
          amountSummary: `${formatCompactBchAmount(selectedWalletPoolPosition.pool.output.amountSatoshis)} + ${formatTokenDisplayAmount(selectedWalletPoolPosition.pool.output.tokenAmount, selectedPoolDecimals, selectedPoolSymbol)}`,
          userPrompt: built.signRequest.transaction.userPrompt ?? null,
        }
      );
      if (result.errorMessage) {
        throw new Error(result.errorMessage);
      }

      const withdrawnPoolId = getPoolSelectionId(
        selectedWalletPoolPosition.pool
      );
      removeCreatedWalletPoolPosition(currentNetwork, withdrawnPoolId);
      const nextSuppressedWalletPoolIds = suppressedWalletPoolIds.includes(
        withdrawnPoolId
      )
        ? suppressedWalletPoolIds
        : [withdrawnPoolId, ...suppressedWalletPoolIds];
      setSuppressedWalletPoolIds(nextSuppressedWalletPoolIds);
      setWalletPoolPositions((current) =>
        current.filter(
          (position) => getPoolSelectionId(position.pool) !== withdrawnPoolId
        )
      );
      setPendingWalletPoolPositions((current) =>
        current.filter(
          (position) => getPoolSelectionId(position.pool) !== withdrawnPoolId
        )
      );
      setSelectedWalletPoolId(null);
      setSelectedWalletPoolHistory(null);
      setSelectedWalletPoolApy(null);

      showBroadcastNotice(
        result.broadcastState === 'submitted'
          ? 'Pool withdrawal submitted'
          : 'Pool withdrawal broadcasted',
        result.broadcastState === 'submitted'
          ? `Keeping ${result.txid} under watch while the wallet refreshes in the background.`
          : `Broadcast completed with ${result.txid}.`,
        'submitted',
        result.txid
      );
      setMessage(`Pool withdrawal submitted: ${result.txid}`);
      await refreshCauldronState(nextSuppressedWalletPoolIds);
      resetCauldronViewState(nextSuppressedWalletPoolIds);
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : 'Unable to withdraw Cauldron pool'
      );
    }
  };

  const handleConfirmPoolReview = async () => {
    if (!poolReview) return;

    try {
      setSubmitting(true);
      setMessage(null);
      showBroadcastNotice(
        poolReview.kind === 'create'
          ? 'Broadcasting pool creation'
          : 'Broadcasting pool withdrawal',
        'Preparing the transaction for submission.',
        'broadcasting'
      );

      if (poolReview.kind === 'create') {
        const poolTokenCategory =
          poolReview.built.poolOutput.token != null
            ? binToHex(poolReview.built.poolOutput.token.category)
            : selectedTokenId;
        if (!poolTokenCategory) {
          throw new Error('Pool review is missing a token category.');
        }
        assertPoolCreateAmountsWithinBalance(
          poolReview.bchAmount,
          poolReview.tokenAmount
        );
        const addresses = await sdk.wallet.listAddresses();
        const ownerAddress =
          addresses[0]?.address || addresses[0]?.tokenAddress;
        const changeAddress = addresses[0]?.address;
        if (!ownerAddress || !changeAddress) {
          throw new Error('No wallet address is available for pool creation.');
        }

        const walletUtxos = await sdk.utxos.listForWallet();
        const mergedWalletUtxos = mergeWalletUtxoLists(walletUtxos);
        assertWalletInputsStillAvailable(
          mergedWalletUtxos,
          poolReview.built.walletInputs.map((input) => input.utxo),
          'Cauldron pool creation'
        );
        const rebuilt = await buildPoolDepositWithFunding({
          walletId: walletContext.walletId,
          allUtxos: mergedWalletUtxos,
          tokenCategoryHex: poolTokenCategory,
          tokenAmount: poolReview.tokenAmount,
          bchAmountSatoshis: poolReview.bchAmount,
          ownerAddress,
          changeAddress,
          withdrawPublicKeyHash: derivePublicKeyHash(ownerAddress),
          feeRate,
          userPrompt:
            poolReview.built.signRequest.transaction.userPrompt ??
            `Create Cauldron pool ${formatBchAmount(poolReview.bchAmount)} BCH + ${formatTokenAmount(poolReview.tokenAmount, effectiveDecimals)} ${effectiveSymbol}`,
        });

        const result = await signAndBroadcastCauldronPoolDepositRequest(
          walletContext.walletId,
          rebuilt,
          {
            sourceLabel: 'Cauldron Pool',
            recipientSummary: effectiveName || poolTokenCategory,
            amountSummary: `${formatBchAmount(poolReview.bchAmount)} BCH + ${formatTokenAmount(poolReview.tokenAmount, effectiveDecimals)} ${effectiveSymbol}`,
            userPrompt: rebuilt.signRequest.transaction.userPrompt ?? null,
          }
        );
        if (result.errorMessage) {
          throw new Error(result.errorMessage);
        }

        const createdPool: CauldronPool = {
          version: CAULDRON_V0_VERSION,
          txHash: result.txid,
          outputIndex: 0,
          ownerAddress,
          ownerPublicKeyHash: binToHex(rebuilt.withdrawPublicKeyHash),
          poolId: null,
          parameters: {
            withdrawPublicKeyHash: rebuilt.withdrawPublicKeyHash,
          },
          output: {
            amountSatoshis: poolReview.bchAmount,
            tokenCategory: poolTokenCategory,
            tokenAmount: poolReview.tokenAmount,
            lockingBytecode: rebuilt.poolOutput.lockingBytecode,
          },
        };
        const createdPosition: CauldronWalletPoolPosition = {
          pool: createdPool,
          ownerAddress,
          matchingNftUtxos: [],
          hasMatchingTokenNft: false,
          detectionSource: 'owner_pkh',
        };
        setPendingWalletPoolPositions((current) =>
          dedupeWalletPoolPositions([createdPosition, ...current])
        );
        pendingWalletPoolPositionsRef.current = dedupeWalletPoolPositions([
          createdPosition,
          ...pendingWalletPoolPositionsRef.current,
        ]);
        setWalletPoolPositions((current) =>
          dedupeWalletPoolPositions([createdPosition, ...current])
        );
        persistCreatedWalletPoolPositions(currentNetwork, [
          createdPosition,
          ...loadCreatedWalletPoolPositions(currentNetwork).filter(
            (position) =>
              getPoolSelectionId(position.pool) !==
              getPoolSelectionId(createdPool)
          ),
        ]);
        persistCreatedWalletPoolTokenCategories(currentNetwork, [
          poolTokenCategory,
          ...loadCreatedWalletPoolTokenCategories(currentNetwork).filter(
            (tokenId) => tokenId !== poolTokenCategory.toLowerCase()
          ),
        ]);
        persistCreatedWalletPoolLockingBytecodes(currentNetwork, [
          rebuilt.poolOutput.lockingBytecode,
          ...loadCreatedWalletPoolLockingBytecodes(currentNetwork).filter(
            (lockingBytecode) =>
              binToHex(lockingBytecode).toLowerCase() !==
              binToHex(rebuilt.poolOutput.lockingBytecode).toLowerCase()
          ),
        ]);

        showBroadcastNotice(
          result.broadcastState === 'submitted'
            ? 'Pool creation submitted'
            : 'Pool creation broadcasted',
          result.broadcastState === 'submitted'
            ? `Keeping ${result.txid} under watch while the wallet refreshes in the background.`
            : `Broadcast completed with ${result.txid}.`,
          'submitted',
          result.txid
        );
        setMessage(`Pool submitted: ${result.txid}`);
        await refreshCauldronState();
        resetCauldronViewState();
        return;
      }

      const addresses = dedupeWalletAddressEntries([
        ...(await sdk.wallet.listAddresses()),
        ...(await fetchCauldronDerivedWalletAddresses(
          walletContext.walletId,
          currentNetwork
        )),
      ]);
      const ownerAddress = resolvePoolWithdrawalOwnerAddress({
        addresses,
        poolOwnerAddress: poolReview.pool.ownerAddress,
        withdrawPublicKeyHash: resolveCauldronPoolWithdrawPublicKeyHash(
          poolReview.pool
        ),
      });
      if (!ownerAddress) {
        throw new Error(
          'No wallet address matches this pool owner. Withdraw is not available from this wallet.'
        );
      }

      const currentPool = resolveCurrentPoolForReview(
        poolReview.pool,
        visibleWalletPoolPositions
      );
      const recipientAddress =
        addresses[0]?.tokenAddress || addresses[0]?.address || ownerAddress;
      const walletUtxos = await sdk.utxos.listForWallet();
      const mergedWalletUtxos = mergeWalletUtxoLists(walletUtxos);
      assertWalletInputsStillAvailable(
        mergedWalletUtxos,
        [poolReview.built.ownerInput.utxo],
        'Cauldron pool withdrawal'
      );
      const rebuilt = await buildPoolWithdrawWithFunding({
        walletId: walletContext.walletId,
        allUtxos: mergedWalletUtxos,
        pool: currentPool,
        ownerAddress,
        recipientAddress,
        feeRate,
        userPrompt:
          poolReview.built.signRequest.transaction.userPrompt ??
          `Withdraw Cauldron pool ${selectedPoolName}`,
      });

      const result = await signAndBroadcastCauldronPoolWithdrawRequest(
        walletContext.walletId,
        rebuilt,
        {
          sourceLabel: 'Cauldron Pool Withdraw',
          recipientSummary: selectedPoolName,
          amountSummary: `${formatCompactBchAmount(currentPool.output.amountSatoshis)} + ${formatTokenDisplayAmount(currentPool.output.tokenAmount, selectedPoolDecimals, selectedPoolSymbol)}`,
          userPrompt: rebuilt.signRequest.transaction.userPrompt ?? null,
        }
      );
      if (result.errorMessage) {
        throw new Error(result.errorMessage);
      }

      const withdrawnPoolId = getPoolSelectionId(currentPool);
      removeCreatedWalletPoolPosition(currentNetwork, withdrawnPoolId);
      const nextSuppressedWalletPoolIds = suppressedWalletPoolIds.includes(
        withdrawnPoolId
      )
        ? suppressedWalletPoolIds
        : [withdrawnPoolId, ...suppressedWalletPoolIds];
      setSuppressedWalletPoolIds(nextSuppressedWalletPoolIds);
      setWalletPoolPositions((current) =>
        current.filter(
          (position) => getPoolSelectionId(position.pool) !== withdrawnPoolId
        )
      );
      setPendingWalletPoolPositions((current) =>
        current.filter(
          (position) => getPoolSelectionId(position.pool) !== withdrawnPoolId
        )
      );
      setSelectedWalletPoolId(null);
      setSelectedWalletPoolHistory(null);
      setSelectedWalletPoolApy(null);

      showBroadcastNotice(
        result.broadcastState === 'submitted'
          ? 'Pool withdrawal submitted'
          : 'Pool withdrawal broadcasted',
        result.broadcastState === 'submitted'
          ? `Keeping ${result.txid} under watch while the wallet refreshes in the background.`
          : `Broadcast completed with ${result.txid}.`,
        'submitted',
        result.txid
      );
      setMessage(`Pool withdrawal submitted: ${result.txid}`);
      await refreshCauldronState(nextSuppressedWalletPoolIds);
      resetCauldronViewState(nextSuppressedWalletPoolIds);
    } catch (error) {
      showBroadcastNotice(
        'Pool broadcast failed',
        error instanceof Error ? error.message : 'Unable to broadcast pool',
        'error'
      );
      setMessage(
        error instanceof Error
          ? error.message
          : 'Unable to submit Cauldron pool transaction'
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="container relative mx-auto flex h-[calc(100dvh-var(--navbar-height)-var(--safe-bottom))] min-h-0 max-w-md flex-col overflow-hidden px-4 pt-2 pb-[calc(var(--safe-bottom)+1rem)] wallet-page">
      <div className="flex-none">
        <div className="flex justify-center">
          <img
            src="/assets/images/cauldron-header-logo.png"
            alt="Cauldron"
            className="h-auto w-full max-w-[220px] object-contain"
          />
        </div>
        <div className="mt-2 flex items-center justify-between gap-3">
          <h1 className="min-w-0 truncate text-lg font-bold tracking-[-0.02em] wallet-text-strong">
            {app.name}
          </h1>
          <button
            type="button"
            onClick={() => navigate(backTarget)}
            className="wallet-btn-danger px-3 py-1.5 text-xs"
          >
            Back
          </button>
        </div>
      </div>

      <div className={`flex min-h-0 flex-1 flex-col pt-2 ${contentClassName}`}>
        {message ? (
          <div className="mb-2">
            <div className="wallet-warning-panel rounded-2xl px-4 py-2.5 text-sm shadow-lg">
              {message}
            </div>
          </div>
        ) : null}

        {broadcastNotice ? (
          <div className="absolute inset-0 z-[80] flex items-center justify-center bg-black/45 px-4">
            <div className="wallet-card w-full max-w-[360px] rounded-[28px] border border-[var(--wallet-border)] p-4 shadow-[0_24px_70px_rgba(0,0,0,0.35)]">
              <div className="flex flex-col items-center text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-300">
                  {broadcastNotice.kind === 'error' ? (
                    <span className="text-xl leading-none">!</span>
                  ) : (
                    <div className="h-5 w-5 animate-spin rounded-full border-2 border-emerald-300 border-t-transparent" />
                  )}
                </div>
                <div className="mt-4 text-lg font-semibold wallet-text-strong">
                  {broadcastNotice.title}
                </div>
                <div className="mt-2 text-sm leading-6 wallet-muted">
                  {broadcastNotice.subtitle}
                </div>
                {broadcastNotice.txid ? (
                  <div className="mt-3 rounded-full border border-[var(--wallet-border)] px-3 py-1 text-xs tracking-[0.08em] wallet-muted">
                    {shortenHash(broadcastNotice.txid)}
                  </div>
                ) : null}
                <button
                  type="button"
                  onClick={clearBroadcastNotice}
                  className="wallet-btn-secondary mt-4 w-full px-4 py-2.5"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        ) : null}

        <div className="wallet-card mt-2 flex-none p-1 first:mt-0">
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setActiveView('swap')}
              className={`${segmentedBaseClass} py-2`}
              style={
                activeView === 'swap'
                  ? activeSegmentStyle
                  : inactiveSegmentStyle
              }
            >
              Swap
            </button>
            <button
              type="button"
              onClick={() => setActiveView('pool')}
              className={`${segmentedBaseClass} py-2`}
              style={
                activeView === 'pool'
                  ? activeSegmentStyle
                  : inactiveSegmentStyle
              }
            >
              Pool
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain touch-pan-y pr-1 pt-2">
          {activeView === 'swap' ? (
            <div className="space-y-2 pb-2">
              <div className="wallet-card p-2.5">
                <div className="space-y-1.5">
                  <div
                    className="rounded-[22px] border px-3 py-2.5"
                    style={{
                      backgroundColor: 'var(--wallet-surface)',
                      borderColor: 'var(--wallet-border)',
                    }}
                  >
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <span className="min-w-0 truncate text-sm font-semibold wallet-muted">
                        You pay
                      </span>
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="min-w-0 truncate text-xs wallet-muted opacity-80">
                          {payBalanceCaption}
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            setAmount(
                              direction === 'bch_to_token'
                                ? formatCompactBchAmount(currentSwapMaxInput)
                                : formatTokenAmount(
                                    currentSwapMaxInput,
                                    effectiveDecimals
                                  )
                            );
                            setQuote(null);
                          }}
                          className="wallet-btn-secondary px-2.5 py-1 text-[11px]"
                          disabled={
                            loading || submitting || currentSwapMaxInput <= 0n
                          }
                        >
                          Max
                        </button>
                      </div>
                    </div>
                    <div
                      className="rounded-xl border px-3 py-2"
                      style={{
                        backgroundColor: 'var(--wallet-surface-strong)',
                        borderColor: 'var(--wallet-border)',
                      }}
                    >
                      {direction === 'bch_to_token'
                        ? renderAssetBadge('BCH', 'Wallet', null, 'bch')
                        : renderTokenPickerTrigger(true)}
                    </div>
                    <div
                      className="mt-3"
                      onClick={() => amountInputRef.current?.focus()}
                      role="presentation"
                    >
                      <div className="flex items-end gap-2">
                        <input
                          ref={amountInputRef}
                          value={amount}
                          onChange={(event) => {
                            const decimals =
                              direction === 'bch_to_token'
                                ? 8
                                : effectiveDecimals;
                            const sanitizedAmount = sanitizeDecimalInput(
                              event.target.value,
                              decimals,
                              currentSwapMaxInput,
                              direction === 'bch_to_token'
                                ? formatCompactBchAmount
                                : formatTokenAmount
                            );
                            const parsedNextAmount = parseDecimalToAtomic(
                              sanitizedAmount,
                              decimals
                            );
                            let nextAmount = sanitizedAmount;
                            if (parsedNextAmount != null) {
                              if (
                                minExecutableRouteInput > 0n &&
                                parsedNextAmount < minExecutableRouteInput
                              ) {
                                nextAmount = formatTokenAmount(
                                  minExecutableRouteInput,
                                  decimals
                                );
                              } else if (
                                currentSwapMaxInput > 0n &&
                                parsedNextAmount > currentSwapMaxInput
                              ) {
                                nextAmount = formatTokenAmount(
                                  currentSwapMaxInput,
                                  decimals
                                );
                              }
                            }
                            if (nextAmount !== event.target.value) {
                              setMessage('Adjusted to fit range.');
                            }
                            setAmount(nextAmount);
                            setQuote(null);
                          }}
                          inputMode="decimal"
                          pattern="[0-9]*[.,]?[0-9]*"
                          enterKeyHint="done"
                          placeholder={
                            direction === 'bch_to_token' ? '0.001' : '1'
                          }
                          className="min-w-0 flex-1 border-0 bg-transparent p-0 text-3xl font-bold leading-none wallet-text-strong outline-none"
                          disabled={loading || submitting}
                        />
                        <span className="shrink-0 pb-0.5 text-base font-semibold wallet-muted">
                          {payUnitLabel}
                        </span>
                      </div>
                      <div className="mt-1.5 truncate text-xs wallet-muted">
                        Wallet: {swapPayBalanceLabel}
                      </div>
                      <div className="mt-0.5 truncate text-xs wallet-muted">
                        Range:{' '}
                        {minExecutableRouteInput > 0n
                          ? direction === 'bch_to_token'
                            ? `${formatCompactBchAmount(minExecutableRouteInput)} - ${formatCompactBchAmount(maxRoutableBchToToken)}`
                            : `${formatTokenDisplayAmount(
                                minExecutableRouteInput,
                                effectiveDecimals,
                                effectiveSymbol
                              )} - ${formatTokenDisplayAmount(
                                maxRoutableTokenToBch,
                                effectiveDecimals,
                                effectiveSymbol
                              )}`
                          : 'Get quote'}
                      </div>
                      {swapAmountExceedsBalance ? (
                        <div className="mt-1 text-xs text-amber-200">
                          Above current range.
                        </div>
                      ) : null}
                    </div>
                  </div>

                  <div className="flex justify-center py-0.5">
                    <button
                      type="button"
                      onClick={() => {
                        setDirection((current) =>
                          current === 'bch_to_token'
                            ? 'token_to_bch'
                            : 'bch_to_token'
                        );
                        setAmount((current) =>
                          current === '0.001' ? '1' : '0.001'
                        );
                        setQuote(null);
                      }}
                      className="flex h-10 w-10 items-center justify-center rounded-xl border text-xl wallet-text-strong"
                      style={{
                        backgroundColor: 'var(--wallet-surface-strong)',
                        borderColor: 'var(--wallet-border)',
                        boxShadow: 'var(--wallet-shadow-card)',
                      }}
                      aria-label="Flip swap direction"
                    >
                      <span aria-hidden="true">⌄</span>
                    </button>
                  </div>

                  <div
                    className="rounded-[22px] border px-3 py-3"
                    style={{
                      backgroundColor: 'var(--wallet-surface)',
                      borderColor: 'var(--wallet-border)',
                    }}
                  >
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <span className="min-w-0 truncate text-sm font-semibold wallet-muted">
                        You receive
                      </span>
                      <span className="min-w-0 truncate text-xs wallet-muted opacity-80">
                        {receiveBalanceCaption}
                      </span>
                    </div>
                    <div
                      className="rounded-xl border px-3 py-2"
                      style={{
                        backgroundColor: 'var(--wallet-surface-strong)',
                        borderColor: 'var(--wallet-border)',
                      }}
                    >
                      {direction === 'bch_to_token'
                        ? renderTokenPickerTrigger(true)
                        : renderAssetBadge('BCH', 'Wallet', null, 'bch')}
                    </div>
                    <div className="mt-3">
                      <div className="flex min-w-0 items-end gap-2">
                        <div className="min-w-0 truncate text-3xl font-bold leading-none wallet-text-strong">
                          {outputDisplayValue}
                        </div>
                        <span className="shrink-0 pb-0.5 text-base font-semibold wallet-muted">
                          {receiveUnitLabel}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="mt-3 grid grid-cols-[1fr_auto] items-end gap-2">
                  <label className="block">
                    <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.2em] wallet-muted">
                      Slippage
                    </span>
                    <select
                      value={slippageBps}
                      onChange={(event) => setSlippageBps(event.target.value)}
                      className={`${fieldClass} py-2.5`}
                      style={fieldStyle}
                      disabled={submitting}
                    >
                      <option value="50">0.50%</option>
                      <option value="100">1.00%</option>
                      <option value="300">3.00%</option>
                      <option value="500">5.00%</option>
                    </select>
                  </label>

                  <button
                    type="button"
                    onClick={
                      quote ? handleReviewSwap : handleQuoteAndOpenDetails
                    }
                    disabled={
                      quoteActionsDisabled ||
                      loading ||
                      quoting ||
                      submitting ||
                      !canSwap ||
                      !selectedTokenId
                    }
                    className="wallet-btn-primary min-w-[128px] px-4 py-[13px] text-base"
                  >
                    {submitting
                      ? 'Signing...'
                      : quoting
                        ? 'Loading...'
                        : quote
                          ? 'Review Swap'
                          : 'Get Quote'}
                  </button>
                </div>
                <div className="mt-2 px-1 text-xs wallet-muted">
                  Slippage sets minimum.
                </div>
              </div>

              {quoteSafetyBanner ? (
                <div className="wallet-warning-panel rounded-2xl px-4 py-3 text-sm shadow-lg">
                  <div className="text-xs font-semibold uppercase tracking-[0.18em] wallet-text-strong">
                    {quoteSafetyBanner.title}
                  </div>
                  <div className="mt-2 space-y-1.5 wallet-text-strong">
                    {quoteSafetyBanner.messages.map((warning) => (
                      <div key={warning}>{warning}</div>
                    ))}
                  </div>
                </div>
              ) : null}

              {quoteRateLabel ? (
                <div className="wallet-card p-2.5">
                  <div className="flex items-center justify-between gap-3 text-sm wallet-text-strong">
                    <span className="min-w-0 truncate">{quoteRateLabel}</span>
                    <button
                      type="button"
                      onClick={() => setQuoteDetailsOpen(true)}
                      className="wallet-btn-secondary shrink-0 px-3 py-1.5 text-xs"
                    >
                      Details
                    </button>
                  </div>
                </div>
              ) : previewError ? (
                <div className="px-1 text-xs text-amber-200">
                  {previewError}
                </div>
              ) : (
                <div className="px-1 text-xs wallet-muted">
                  Enter an amount.
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-4 pb-3">
              <div className="wallet-card p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-xs uppercase tracking-[0.18em] wallet-muted opacity-70">
                      Pools
                    </div>
                    <h2 className="mt-1 text-xl font-semibold wallet-text-strong">
                      {visibleWalletPoolPositions.length > 0
                        ? 'Owned'
                        : 'Market'}
                    </h2>
                  </div>
                  <button
                    type="button"
                    className="wallet-btn-primary px-4 py-2 text-sm"
                    onClick={() => void handleCreatePool()}
                    disabled={submitting || !canCreatePool}
                  >
                    {submitting ? 'Working...' : 'Create'}
                  </button>
                </div>

                <label className="mt-4 block">
                  <span className="mb-2 block text-xs font-semibold uppercase tracking-[0.2em] wallet-muted">
                    Market Filter
                  </span>
                  {renderTokenPickerTrigger()}
                </label>

                <div className="mt-4 grid grid-cols-2 gap-3">
                  <label className="block">
                    <span className="mb-2 block text-xs font-semibold uppercase tracking-[0.2em] wallet-muted">
                      BCH
                    </span>
                    <div className="relative">
                      <input
                        value={poolCreateBchAmount}
                        onChange={(event) => {
                          const nextAmount = sanitizeDecimalInput(
                            event.target.value,
                            8,
                            poolBchMaxInputSats
                          );
                          if (nextAmount !== event.target.value) {
                            setMessage('Adjusted to fit balance.');
                          }
                          setPoolTokenAmountAuto(true);
                          setPoolSyncAnchor('bch');
                          syncPoolFromBchAmount(nextAmount);
                        }}
                        placeholder="0.01"
                        className={`${fieldClass} pr-16`}
                        style={fieldStyle}
                        disabled={submitting}
                        inputMode="decimal"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          setPoolTokenAmountAuto(true);
                          setPoolSyncAnchor('bch');
                          syncPoolFromBchAmount(
                            formatTokenAmount(poolBchMaxInputSats, 8)
                          );
                        }}
                        className="wallet-btn-secondary absolute right-2 top-1/2 -translate-y-1/2 px-2.5 py-1 text-[11px]"
                        disabled={submitting || poolBchMaxInputSats <= 0n}
                      >
                        Max
                      </button>
                    </div>
                    <div className="mt-2 text-xs wallet-muted">
                      Wallet: {poolBchBalanceLabel}
                    </div>
                  </label>
                  <label className="block">
                    <span className="mb-2 block text-xs font-semibold uppercase tracking-[0.2em] wallet-muted">
                      {effectiveSymbol}
                    </span>
                    <div className="relative">
                      <input
                        value={poolCreateTokenAmount}
                        onChange={(event) => {
                          const nextAmount = sanitizeDecimalInput(
                            event.target.value,
                            effectiveDecimals,
                            spendableTokenBalanceAtomic,
                            formatTokenAmount
                          );
                          if (nextAmount !== event.target.value) {
                            setMessage('Adjusted to fit balance.');
                          }
                          setPoolTokenAmountAuto(true);
                          setPoolSyncAnchor('token');
                          syncPoolFromTokenAmount(nextAmount);
                        }}
                        placeholder="0"
                        className={`${fieldClass} pr-16`}
                        style={fieldStyle}
                        disabled={submitting}
                        inputMode="decimal"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          setPoolTokenAmountAuto(true);
                          setPoolSyncAnchor('token');
                          syncPoolFromTokenAmount(
                            formatTokenAmount(
                              spendableTokenBalanceAtomic,
                              effectiveDecimals
                            )
                          );
                        }}
                        className="wallet-btn-secondary absolute right-2 top-1/2 -translate-y-1/2 px-2.5 py-1 text-[11px]"
                        disabled={
                          submitting || spendableTokenBalanceAtomic <= 0n
                        }
                      >
                        Max
                      </button>
                    </div>
                    <div className="mt-2 text-xs wallet-muted">
                      Wallet: {poolTokenBalanceLabel}
                    </div>
                  </label>
                </div>
                <div className="mt-2 px-1 text-xs wallet-muted">
                  {!parsedPoolCreateBchAmount || parsedPoolCreateBchAmount <= 0n
                    ? 'Enter BCH.'
                    : !parsedPoolCreateTokenAmount ||
                        parsedPoolCreateTokenAmount <= 0n
                      ? `Enter ${effectiveSymbol}.`
                      : parsedPoolCreateBchAmount > poolBchMaxInputSats
                        ? 'BCH exceeds balance.'
                        : parsedPoolCreateTokenAmount >
                            spendableTokenBalanceAtomic
                          ? `${effectiveSymbol} exceeds balance.`
                          : 'Ready to sign.'}
                </div>
                <div className="mt-1 px-1 text-xs wallet-muted">
                  {marketRatioCaption}
                </div>
                <div className="mt-2 px-1">
                  <button
                    type="button"
                    onClick={() => {
                      setPoolTokenAmountAuto(true);
                      setPoolSyncAnchor('bch');
                      syncPoolFromBchAmount(poolCreateBchAmount);
                    }}
                    className="wallet-btn-secondary px-3 py-1.5 text-xs"
                    disabled={submitting || !selectedTokenSpotPriceSats}
                  >
                    Use ratio
                  </button>
                </div>
              </div>

              <div className="wallet-card p-3">
                {visibleWalletPoolPositions.length > 0 ? (
                  <div className="space-y-2">
                    <div className="mb-1 text-xs uppercase tracking-[0.18em] wallet-muted opacity-70">
                      LPs
                    </div>
                    <div
                      className="space-y-2 overflow-y-auto pr-1"
                      style={{
                        maxHeight:
                          visibleWalletPoolPositions.length > 1
                            ? '16rem'
                            : 'none',
                      }}
                    >
                      {visibleWalletPoolPositions.map((position) => {
                        const poolMetadata =
                          sharedMetadata[position.pool.output.tokenCategory];
                        const poolToken =
                          tokenById.get(position.pool.output.tokenCategory) ??
                          null;
                        const poolTokenSymbol =
                          poolMetadata?.symbol ??
                          poolToken?.symbol ??
                          shortTokenId(position.pool.output.tokenCategory);
                        const poolTokenName =
                          poolMetadata?.name ??
                          poolToken?.name ??
                          `Token ${shortTokenId(position.pool.output.tokenCategory)}`;
                        const poolTokenDecimals =
                          poolMetadata?.decimals ?? poolToken?.decimals ?? 0;
                        return (
                          <button
                            key={
                              position.pool.poolId ??
                              `${position.pool.txHash}:${position.pool.outputIndex}`
                            }
                            type="button"
                            onClick={() => {
                              setSelectedWalletPoolId(
                                getPoolSelectionId(position.pool)
                              );
                            }}
                            className="w-full rounded-2xl border px-3 py-2.5 text-left transition"
                            style={
                              selectedWalletPoolPosition &&
                              getPoolSelectionId(
                                selectedWalletPoolPosition.pool
                              ) === getPoolSelectionId(position.pool)
                                ? {
                                    borderColor: 'var(--wallet-accent)',
                                    backgroundColor:
                                      'var(--wallet-selectable-active-bg)',
                                  }
                                : {
                                    borderColor: 'var(--wallet-border)',
                                    backgroundColor:
                                      'color-mix(in oklab, var(--wallet-card-bg) 74%, transparent)',
                                  }
                            }
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div>
                                <div className="text-sm font-semibold wallet-text-strong">
                                  {poolTokenName}
                                </div>
                              </div>
                              <div className="wallet-surface-strong rounded-full px-3 py-1 text-xs font-semibold wallet-text-strong">
                                {poolTokenSymbol}
                              </div>
                            </div>

                            <div className="mt-3 flex items-center justify-between gap-3 text-xs">
                              <span className="wallet-muted">Liquidity</span>
                              <span className="font-medium text-white">
                                {formatCompactBchAmount(
                                  position.pool.output.amountSatoshis
                                )}{' '}
                                -{' '}
                                {formatTokenDisplayAmount(
                                  position.pool.output.tokenAmount,
                                  poolTokenDecimals,
                                  poolTokenSymbol
                                )}
                              </span>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ) : (
                  <p className="text-sm wallet-muted">No LPs.</p>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {reviewOpen && quote ? (
        <ContainedSwipeConfirmModal
          open={reviewOpen}
          title="Review Cauldron Swap"
          subtitle={
            direction === 'bch_to_token'
              ? `Pay BCH, receive ${effectiveSymbol}`
              : `Pay ${effectiveSymbol}, receive BCH`
          }
          loading={submitting}
          canConfirm={!reviewWarningsAcceptedNeeded || reviewWarningsAccepted}
          warning={
            quoteSafetyBanner ? (
              <span>{quoteSafetyBanner.title}</span>
            ) : quoteReviewWarnings.length > 0 ? (
              <span>Review warnings, then slide.</span>
            ) : (
              <span>Slide to confirm.</span>
            )
          }
          onCancel={() => setReviewOpen(false)}
          onConfirm={handleConfirmSwapReview}
        >
          <div className="space-y-3 px-1 py-2 text-sm">
            <div className="rounded-2xl border border-[var(--wallet-border)] px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <span className="wallet-muted">Pay</span>
                <span className="font-medium wallet-text-strong">
                  {spendSummary}
                </span>
              </div>
              <div className="mt-2 flex items-center justify-between gap-3">
                <span className="wallet-muted">Receive</span>
                <span className="font-medium wallet-text-strong">
                  {receiveSummary}
                </span>
              </div>
              <div className="mt-2 flex items-center justify-between gap-3">
                <span className="wallet-muted">Minimum receive</span>
                <span className="font-medium wallet-text-strong">
                  {direction === 'bch_to_token'
                    ? formatTokenDisplayAmount(
                        quote.minReceive,
                        effectiveDecimals,
                        effectiveSymbol
                      )
                    : formatCompactBchAmount(quote.minReceive)}
                </span>
              </div>
            </div>

            {quoteRiskSummary ? (
              <div
                className={`rounded-2xl border px-4 py-3 ${
                  quoteRiskSummary.highSlippage ||
                  quoteRiskSummary.highLiquidityUsage
                    ? 'border-[var(--wallet-warning-border)] bg-[var(--wallet-warning-bg)]'
                    : 'border-[var(--wallet-border)]'
                }`}
              >
                <div className="text-xs font-semibold uppercase tracking-[0.18em] wallet-text-strong">
                  Liquidity & slippage check
                </div>
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  <div
                    className={`rounded-xl border px-3 py-2 ${
                      quoteRiskSummary.highSlippage
                        ? 'border-[var(--wallet-warning-border)] bg-[var(--wallet-surface-strong)]'
                        : 'border-[var(--wallet-border)] bg-[var(--wallet-surface-strong)]'
                    }`}
                  >
                    <div className="text-xs uppercase tracking-[0.14em] wallet-muted opacity-70">
                      Slippage
                    </div>
                    <div className="mt-1 text-lg font-semibold wallet-text-strong">
                      {formatUnsignedPercentValue(
                        Number(quoteRiskSummary.slippageBps) / 100
                      )}
                    </div>
                    <div className="mt-1 text-xs wallet-muted">
                      {quoteRiskSummary.highSlippage
                        ? 'High for a wallet-confirmed swap.'
                        : 'Within the default safety threshold.'}
                    </div>
                  </div>

                  <div
                    className={`rounded-xl border px-3 py-2 ${
                      quoteRiskSummary.highLiquidityUsage
                        ? 'border-[var(--wallet-warning-border)] bg-[var(--wallet-surface-strong)]'
                        : 'border-[var(--wallet-border)] bg-[var(--wallet-surface-strong)]'
                    }`}
                  >
                    <div className="text-xs uppercase tracking-[0.14em] wallet-muted opacity-70">
                      Market depth used
                    </div>
                    <div className="mt-1 text-lg font-semibold wallet-text-strong">
                      {formatUnsignedPercentValue(
                        Number(quoteRiskSummary.marketUsageBps) / 100
                      )}
                    </div>
                    <div className="mt-1 text-xs wallet-muted">
                      {quoteRiskSummary.highLiquidityUsage
                        ? 'This quote uses most of the currently executable market depth.'
                        : 'Leaves room for a cleaner unwind if the market stays steady.'}
                    </div>
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap gap-2 text-xs font-semibold">
                  <span className="rounded-full bg-[var(--wallet-surface-strong)] px-3 py-1 wallet-text-strong">
                    Route: {quoteRiskSummary.routePoolCount} pools
                  </span>
                  <span className="rounded-full bg-[var(--wallet-surface-strong)] px-3 py-1 wallet-text-strong">
                    Wallet inputs: {quoteRiskSummary.walletInputCount}
                  </span>
                </div>

                <div className="mt-2 text-xs wallet-muted">
                  Re-quote if the market moves or if you want a tighter fill.
                  The actual transaction is still re-validated before broadcast.
                </div>
              </div>
            ) : null}

            {quoteReviewWarnings.length > 0 ? (
              <div className="rounded-2xl border border-[var(--wallet-warning-border)] bg-[var(--wallet-warning-bg)] px-4 py-3">
                <div className="text-xs font-semibold uppercase tracking-[0.18em] wallet-text-strong">
                  Warnings
                </div>
                <div className="mt-2 space-y-2 text-sm wallet-text-strong">
                  {quoteReviewWarnings.map((warning) => (
                    <div key={warning}>{warning}</div>
                  ))}
                </div>
                <label className="mt-3 flex items-start gap-3 text-sm wallet-text-strong">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={reviewWarningsAccepted}
                    onChange={(event) =>
                      setReviewWarningsAccepted(event.target.checked)
                    }
                  />
                  <span>
                    I reviewed these warnings and still want to continue.
                  </span>
                </label>
              </div>
            ) : null}

            <div className="rounded-2xl border border-[var(--wallet-border)] px-4 py-3">
              <div className="text-xs uppercase tracking-[0.18em] wallet-muted opacity-70">
                Route
              </div>
              <div className="mt-2 space-y-2">
                {previewedRouteRows.slice(0, 2).map((trade) => (
                  <div
                    key={
                      trade.pool.poolId ??
                      `${trade.pool.txHash}:${trade.pool.outputIndex}`
                    }
                    className="flex items-center justify-between gap-3 text-sm"
                  >
                    <span className="wallet-muted">
                      {trade.pool.poolId
                        ? `${trade.pool.poolId.slice(0, 8)}...`
                        : `${trade.pool.txHash.slice(0, 8)}:${trade.pool.outputIndex}`}
                    </span>
                    <span className="wallet-text-strong">
                      {direction === 'bch_to_token'
                        ? formatTokenDisplayAmount(
                            trade.demand,
                            effectiveDecimals,
                            effectiveSymbol
                          )
                        : formatCompactBchAmount(trade.demand)}
                    </span>
                  </div>
                ))}
                {previewedRouteRows.length > 2 ? (
                  <div className="text-xs wallet-muted">
                    {previewedRouteRows.length - 2} more pools hidden.
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </ContainedSwipeConfirmModal>
      ) : null}

      {quoteDetailsOpen && quote ? (
        <div className="absolute inset-0 z-30 flex items-end bg-black/50 px-4 pb-4 pt-10">
          <div className="wallet-card flex max-h-[85vh] w-full flex-col rounded-[28px] p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-xs uppercase tracking-[0.18em] wallet-muted opacity-70">
                  Quote Details
                </div>
                <h2 className="mt-1 text-lg font-semibold wallet-text-strong">
                  Current quote breakdown
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setQuoteDetailsOpen(false)}
                className="wallet-btn-secondary px-3 py-1.5 text-xs"
              >
                Close
              </button>
            </div>

            <div className="mt-2 text-xs leading-5 wallet-muted">
              Quote preview.
            </div>

            <div className="mt-3 min-h-0 flex-1 space-y-3 overflow-y-auto pr-1 text-sm">
              <div className="rounded-2xl border border-[var(--wallet-border)] px-3 py-2.5">
                <div className="mb-2 text-[11px] uppercase tracking-[0.18em] wallet-muted">
                  Trade
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <span className="min-w-0 truncate wallet-muted">
                      Min receive
                    </span>
                    <span className="min-w-0 truncate text-right wallet-text-strong">
                      {quote
                        ? direction === 'bch_to_token'
                          ? formatTokenDisplayAmount(
                              quote.minReceive,
                              effectiveDecimals,
                              effectiveSymbol
                            )
                          : formatCompactBchAmount(quote.minReceive)
                        : 'Get quote'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="min-w-0 truncate wallet-muted">
                      Price impact
                    </span>
                    <span className="min-w-0 truncate text-right wallet-text-strong">
                      {priceImpactLabel}
                    </span>
                  </div>
                </div>
              </div>

              <div className="rounded-2xl border border-[var(--wallet-border)] px-3 py-2.5">
                <div className="mb-2 text-[11px] uppercase tracking-[0.18em] wallet-muted">
                  Fees
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <span className="min-w-0 truncate wallet-muted">
                      LP fee
                    </span>
                    <span className="min-w-0 truncate text-right wallet-text-strong">
                      {direction === 'bch_to_token'
                        ? formatCompactBchAmount(totalLpFee)
                        : formatTokenDisplayAmount(
                            totalLpFee,
                            effectiveDecimals,
                            effectiveSymbol
                          )}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="min-w-0 truncate wallet-muted">
                      Platform fee
                    </span>
                    <span className="min-w-0 truncate text-right wallet-text-strong">
                      0 BCH
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="min-w-0 truncate wallet-muted">
                      Network fee
                    </span>
                    <span className="min-w-0 truncate text-right wallet-text-strong">
                      {quote
                        ? formatCompactBchAmount(quote.estimatedFeeSatoshis)
                        : 'Get quote'}
                    </span>
                  </div>
                </div>
              </div>

              <div className="rounded-2xl border border-[var(--wallet-border)] px-3 py-2.5">
                <div className="mb-2 text-[11px] uppercase tracking-[0.18em] wallet-muted">
                  Market
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <span className="min-w-0 truncate wallet-muted">Pools</span>
                    <span className="min-w-0 truncate text-right wallet-text-strong">
                      {previewTradeCount}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="min-w-0 truncate wallet-muted">
                      Min route
                    </span>
                    <span className="min-w-0 truncate text-right wallet-text-strong">
                      {visibleMarketLiquidity
                        ? direction === 'bch_to_token'
                          ? formatCompactBchAmount(minExecutableRouteInput)
                          : formatTokenDisplayAmount(
                              minExecutableRouteInput,
                              effectiveDecimals,
                              effectiveSymbol
                            )
                        : 'Get quote'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="min-w-0 truncate wallet-muted">
                      Max BCH
                    </span>
                    <span className="min-w-0 truncate text-right wallet-text-strong">
                      {visibleMarketLiquidity
                        ? formatCompactBchAmount(maxRoutableBchToToken)
                        : 'Get quote'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="min-w-0 truncate wallet-muted">
                      Max {effectiveSymbol}
                    </span>
                    <span className="min-w-0 truncate text-right wallet-text-strong">
                      {visibleMarketLiquidity
                        ? formatTokenDisplayAmount(
                            maxRoutableTokenToBch,
                            effectiveDecimals,
                            effectiveSymbol
                          )
                        : 'Get quote'}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {poolReview ? (
        <ContainedSwipeConfirmModal
          open={Boolean(poolReview)}
          title={
            poolReview.kind === 'create'
              ? 'Review Pool Creation'
              : 'Review Pool Withdrawal'
          }
          subtitle={selectedPoolName}
          loading={submitting}
          warning={
            <span>
              {poolReview.kind === 'create'
                ? 'Slide to confirm.'
                : 'Slide to confirm.'}
            </span>
          }
          onCancel={() => setPoolReview(null)}
          onConfirm={() => void handleConfirmPoolReview()}
        >
          <div className="space-y-3 px-1 py-2 text-sm">
            <div className="rounded-2xl border border-[var(--wallet-border)] px-4 py-3">
              {poolReview.kind === 'create' ? (
                <>
                  <div className="flex items-center justify-between gap-3">
                    <span className="wallet-muted">Pool BCH</span>
                    <span className="font-medium wallet-text-strong">
                      {formatCompactBchAmount(poolReview.bchAmount)}
                    </span>
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-3">
                    <span className="wallet-muted">Pool token</span>
                    <span className="font-medium wallet-text-strong">
                      {formatTokenDisplayAmount(
                        poolReview.tokenAmount,
                        effectiveDecimals,
                        effectiveSymbol
                      )}
                    </span>
                  </div>
                </>
              ) : (
                <>
                  <div className="flex items-center justify-between gap-3">
                    <span className="wallet-muted">Withdraw BCH</span>
                    <span className="font-medium wallet-text-strong">
                      {formatCompactBchAmount(
                        poolReview.pool.output.amountSatoshis
                      )}
                    </span>
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-3">
                    <span className="wallet-muted">Withdraw token</span>
                    <span className="font-medium wallet-text-strong">
                      {formatTokenDisplayAmount(
                        poolReview.pool.output.tokenAmount,
                        selectedPoolDecimals,
                        selectedPoolSymbol
                      )}
                    </span>
                  </div>
                </>
              )}
              <div className="mt-2 flex items-center justify-between gap-3">
                <span className="wallet-muted">Estimated network fee</span>
                <span className="font-medium wallet-text-strong">
                  {formatCompactBchAmount(
                    poolReview.built.estimatedFeeSatoshis
                  )}
                </span>
              </div>
            </div>
          </div>
        </ContainedSwipeConfirmModal>
      ) : null}

      {selectedWalletPoolPosition ? (
        <div className="absolute inset-0 z-30 flex items-end bg-black/50 px-4 pb-4 pt-4">
          <div className="wallet-card flex max-h-full w-full flex-col rounded-[28px] p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-xs uppercase tracking-[0.18em] wallet-muted opacity-70">
                  LP
                </div>
                <h2 className="mt-1 text-xl font-semibold wallet-text-strong">
                  {selectedPoolName}
                </h2>
              </div>
            </div>

            <div className="mt-4 flex gap-3">
              <button
                type="button"
                onClick={() => setWithdrawConfirmOpen(true)}
                className="wallet-btn-primary flex-1"
                disabled={submitting}
              >
                Withdraw
              </button>
            </div>

            <div className="mt-4 min-h-0 flex-1 overflow-y-auto pr-1">
              <div className="space-y-3 text-sm">
                <div className="rounded-2xl border border-[var(--wallet-border)] px-4 py-3">
                  <div className="text-xs uppercase tracking-[0.18em] wallet-muted opacity-70">
                    Position
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-3">
                    <span className="wallet-muted">BCH reserve</span>
                    <span className="font-medium text-white">
                      {formatCompactBchAmount(
                        selectedWalletPoolPosition.pool.output.amountSatoshis
                      )}
                    </span>
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-3">
                    <span className="wallet-muted">
                      {selectedPoolSymbol} reserve
                    </span>
                    <span className="font-medium text-white">
                      {formatTokenDisplayAmount(
                        selectedWalletPoolPosition.pool.output.tokenAmount,
                        selectedPoolDecimals,
                        selectedPoolSymbol
                      )}
                    </span>
                  </div>
                </div>

                {selectedWalletPoolApy ? (
                  <div className="rounded-2xl border border-[var(--wallet-border)] px-4 py-3">
                    <div className="text-xs uppercase tracking-[0.18em] wallet-muted opacity-70">
                      Yield
                    </div>
                    <div className="mt-3 space-y-2">
                      <div className="flex items-center justify-between gap-3">
                        <span className="wallet-muted">Fee-based APY</span>
                        <span className="font-medium text-white">
                          {selectedWalletPoolApy}
                        </span>
                      </div>
                      {selectedWalletPoolStats.grossYieldPercent ? (
                        <div className="flex items-center justify-between gap-3">
                          <span className="wallet-muted">
                            Visible-window yield
                          </span>
                          <span className="font-medium text-white">
                            {selectedWalletPoolStats.grossYieldPercent}
                          </span>
                        </div>
                      ) : null}
                      {selectedWalletPoolStats.sampleSize > 1 ? (
                        <div className="flex items-center justify-between gap-3">
                          <span className="wallet-muted">History samples</span>
                          <span className="font-medium text-white">
                            {selectedWalletPoolStats.sampleSize}
                          </span>
                        </div>
                      ) : null}
                    </div>
                  </div>
                ) : null}

                {selectedWalletPoolStats.sampleSize > 1 ? (
                  <div className="rounded-2xl border border-[var(--wallet-border)] px-4 py-3">
                    <div className="text-xs uppercase tracking-[0.18em] wallet-muted opacity-70">
                      History
                    </div>
                    <div className="mt-3 flex items-center justify-between gap-3">
                      <span className="wallet-muted">BCH reserve change</span>
                      <span className="font-medium text-white">
                        {formatSignedBchAmount(
                          selectedWalletPoolStats.bchReserveChange ?? 0n
                        )}
                      </span>
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-3">
                      <span className="wallet-muted">
                        {selectedPoolSymbol} reserve change
                      </span>
                      <span className="font-medium text-white">
                        {formatSignedTokenDisplayAmount(
                          selectedWalletPoolStats.tokenReserveChange ?? 0n,
                          selectedPoolDecimals,
                          selectedPoolSymbol
                        )}
                      </span>
                    </div>
                  </div>
                ) : null}
              </div>

              <div className="mt-4 border-t wallet-keyline pt-3">
                <div className="mb-2 text-xs uppercase tracking-[0.18em] wallet-muted opacity-70">
                  Activity
                </div>
                {loadingWalletPoolHistory ? (
                  <p className="text-sm wallet-muted">
                    Loading pool history...
                  </p>
                ) : selectedWalletPoolHistory?.history?.length ? (
                  <div className="max-h-64 space-y-2 overflow-y-auto pr-1">
                    {selectedWalletPoolHistory.history
                      .slice(-5)
                      .reverse()
                      .map((entry, index, recentEntries) => {
                        const previousEntry =
                          selectedWalletPoolHistory.history[
                            selectedWalletPoolHistory.history.length -
                              recentEntries.length +
                              (recentEntries.length - 1 - index) -
                              1
                          ] ?? null;
                        const bchDelta = previousEntry
                          ? parseSatoshis(entry.sats) -
                            parseSatoshis(previousEntry.sats)
                          : null;
                        const tokenDelta = previousEntry
                          ? parseSatoshis(entry.tokens) -
                            parseSatoshis(previousEntry.tokens)
                          : null;

                        return (
                          <div
                            key={`${entry.txid}:${entry.timestamp}`}
                            className="wallet-section rounded-xl px-3 py-2"
                          >
                            <div className="flex items-center justify-between gap-3 text-xs wallet-muted opacity-80">
                              <span>{formatTimestamp(entry.timestamp)}</span>
                              <span className="truncate">
                                {shortTokenId(entry.txid)}
                              </span>
                            </div>
                            <div className="mt-2 flex items-center justify-between gap-3 text-sm">
                              <span className="wallet-muted">BCH</span>
                              <span className="font-medium text-white">
                                {formatCompactBchAmount(
                                  parseSatoshis(entry.sats)
                                )}
                              </span>
                            </div>
                            <div className="mt-1 flex items-center justify-between gap-3 text-sm">
                              <span className="wallet-muted">
                                {selectedPoolSymbol}
                              </span>
                              <span className="font-medium text-white">
                                {formatTokenDisplayAmount(
                                  parseSatoshis(entry.tokens),
                                  selectedPoolDecimals,
                                  selectedPoolSymbol
                                )}
                              </span>
                            </div>
                            {bchDelta !== null && tokenDelta !== null ? (
                              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
                                <span className="wallet-muted">
                                  BCH Δ{' '}
                                  <span className="font-medium text-white">
                                    {formatSignedBchAmount(bchDelta)}
                                  </span>
                                </span>
                                <span className="wallet-muted">
                                  {selectedPoolSymbol} Δ{' '}
                                  <span className="font-medium text-white">
                                    {formatSignedTokenDisplayAmount(
                                      tokenDelta,
                                      selectedPoolDecimals,
                                      selectedPoolSymbol
                                    )}
                                  </span>
                                </span>
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                  </div>
                ) : (
                  <p className="text-sm wallet-muted">
                    No recent LP activity is available yet.
                  </p>
                )}
              </div>
            </div>

            <div className="mt-4 border-t wallet-keyline pt-3">
              <button
                type="button"
                onClick={() => setSelectedWalletPoolId(null)}
                className="wallet-btn-secondary w-full py-2.5"
                disabled={submitting}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <ContainedSwipeConfirmModal
        open={withdrawConfirmOpen}
        title="Withdraw LP"
        subtitle={selectedPoolName}
        loading={submitting}
        warning={<span>Slide to confirm withdrawal.</span>}
        onCancel={() => setWithdrawConfirmOpen(false)}
        onConfirm={() => {
          setWithdrawConfirmOpen(false);
          void handleWithdrawPool();
        }}
      >
        {selectedWalletPoolPosition ? (
          <div className="space-y-3 px-1 py-2 text-sm">
            <div className="rounded-2xl border border-[var(--wallet-border)] px-4 py-3">
              <div className="text-xs uppercase tracking-[0.18em] wallet-muted opacity-70">
                LP Position
              </div>
              <div className="mt-3 flex items-center justify-between gap-3">
                <span className="wallet-muted">Pool</span>
                <span className="font-medium wallet-text-strong">
                  {selectedPoolName}
                </span>
              </div>
              <div className="mt-2 flex items-center justify-between gap-3">
                <span className="wallet-muted">BCH reserve</span>
                <span className="font-medium wallet-text-strong">
                  {formatCompactBchAmount(
                    selectedWalletPoolPosition.pool.output.amountSatoshis
                  )}
                </span>
              </div>
              <div className="mt-2 flex items-center justify-between gap-3">
                <span className="wallet-muted">
                  {selectedPoolSymbol} reserve
                </span>
                <span className="font-medium wallet-text-strong">
                  {formatTokenDisplayAmount(
                    selectedWalletPoolPosition.pool.output.tokenAmount,
                    selectedPoolDecimals,
                    selectedPoolSymbol
                  )}
                </span>
              </div>
            </div>
          </div>
        ) : null}
      </ContainedSwipeConfirmModal>

      {tokenPickerOpen ? (
        <div className="absolute inset-0 z-20 flex items-end bg-black/50 px-4 pb-4 pt-4">
          <div className="wallet-card flex max-h-full w-full flex-col rounded-[28px] p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-xs uppercase tracking-[0.18em] wallet-muted opacity-70">
                  Select Token
                </div>
                <h2 className="mt-1 text-xl font-semibold wallet-text-strong">
                  Cauldron Markets
                </h2>
              </div>
              <button
                type="button"
                onClick={() => {
                  setTokenSearchQuery('');
                  setTokenPickerOpen(false);
                }}
                className="wallet-btn-secondary px-4 py-2"
              >
                Close
              </button>
            </div>

            <div className="mt-4 min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
              <div className="sticky top-0 z-10 pb-2">
                <input
                  type="text"
                  value={tokenSearchQuery}
                  onChange={(event) => setTokenSearchQuery(event.target.value)}
                  placeholder="Search token name or symbol"
                  className={`${fieldClass} py-2.5`}
                  style={fieldStyle}
                />
              </div>

              {tokens.length === 0 ? (
                <div className="rounded-2xl border border-[var(--wallet-border)] px-4 py-3 text-sm wallet-muted">
                  No Cauldron tokens are available right now.
                </div>
              ) : filteredTokens.length === 0 ? (
                <div className="rounded-2xl border border-[var(--wallet-border)] px-4 py-3 text-sm wallet-muted">
                  No close token matches found.
                </div>
              ) : (
                filteredTokens.map((token) => {
                  const metadata = sharedMetadata[token.tokenId];
                  const iconUri = metadata?.iconUri || token.imageUrl || null;
                  const isSelected = token.tokenId === selectedTokenId;

                  return (
                    <button
                      key={token.tokenId}
                      type="button"
                      onClick={() => {
                        selectedTokenManualRef.current = true;
                        setSelectedTokenId(token.tokenId);
                        setQuote(null);
                        setTokenSearchQuery('');
                        setTokenPickerOpen(false);
                      }}
                      className="flex w-full items-center gap-3 rounded-2xl border px-3 py-3 text-left transition"
                      style={{
                        backgroundColor: isSelected
                          ? 'var(--wallet-accent-soft)'
                          : 'var(--wallet-surface)',
                        borderColor: isSelected
                          ? 'var(--wallet-accent)'
                          : 'var(--wallet-border)',
                      }}
                    >
                      {iconUri ? (
                        <img
                          src={iconUri}
                          alt={token.symbol}
                          className="h-10 w-10 rounded-full object-cover"
                        />
                      ) : (
                        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--wallet-accent-soft)] text-sm font-bold wallet-text-strong">
                          {token.symbol.slice(0, 1)}
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-semibold wallet-text-strong">
                          {metadata?.symbol || token.symbol}
                        </div>
                        <div className="truncate text-xs wallet-muted">
                          {metadata?.name || token.name}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-[11px] uppercase tracking-[0.16em] wallet-muted opacity-70">
                          TVL
                        </div>
                        <div className="text-xs font-medium wallet-text-strong">
                          {token.tvlSats > 0
                            ? formatCompactBchAmount(
                                BigInt(Math.trunc(token.tvlSats))
                              )
                            : 'New'}
                        </div>
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
};

export default CauldronSwapApp;
