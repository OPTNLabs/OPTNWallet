import { binToHex, decodeTransaction, hexToBin } from '@bitauth/libauth';

import { Network } from '../../redux/networkSlice';
import KeyService from '../KeyService';
import { parseSatoshis } from '../../utils/binary';
import { derivePublicKeyHash } from '../../utils/derivePublicKeyHash';
import { deriveBchAddressFromHdPublicKey } from '../HdWalletService';
import { CauldronApiClient, type CauldronActivePoolRow } from './api';
import {
  calcCauldronPairRate,
  calcCauldronTradeWithTargetSupply,
  calcCauldronTradeWithTargetDemand,
  createCauldronPoolPair,
  summarizeCauldronTrade,
  toCauldronPoolTrade,
} from './math';
import {
  buildCauldronPoolV0LockingBytecode,
  extractCauldronPoolV0ParametersFromUnlockingBytecode,
  tryParseCauldronPoolFromUtxo,
} from './script';
import {
  CAULDRON_NATIVE_BCH,
  type CauldronDirectionLiquidity,
  type CauldronMarketLiquidity,
  type CauldronPool,
  type CauldronPoolTrade,
  type CauldronTokenId,
  type CauldronTradeSummary,
  type CauldronWalletPoolPosition,
} from './types';
import type { UTXO } from '../../types/types';
import type { OutboundTransactionRecord } from '../OutboundTransactionTracker';

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asHexBytes(value: unknown): Uint8Array | null {
  if (typeof value !== 'string') return null;
  const hex = value.trim().toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]+$/.test(hex) || hex.length % 2 !== 0) return null;
  return hexToBin(hex);
}

function normalizeTokenCategory(value: unknown): string {
  if (typeof value === 'string') return value.trim().toLowerCase();
  if (value instanceof Uint8Array) return binToHex(value).toLowerCase();
  if (Array.isArray(value)) {
    try {
      return binToHex(Uint8Array.from(value as number[])).toLowerCase();
    } catch {
      return '';
    }
  }
  return '';
}

function findString(
  row: Record<string, unknown>,
  keys: string[]
): string {
  for (const key of keys) {
    const value = asString(row[key]);
    if (value) return value;
  }
  return '';
}

function findBigInt(
  row: Record<string, unknown>,
  keys: string[]
): bigint {
  for (const key of keys) {
    const value = parseSatoshis(row[key]);
    if (value > 0n) return value;
  }
  return 0n;
}

function findHex(
  row: Record<string, unknown>,
  keys: string[]
): Uint8Array | null {
  for (const key of keys) {
    const value = asHexBytes(row[key]);
    if (value) return value;
  }
  return null;
}

export function normalizeCauldronPoolRow(
  row: CauldronActivePoolRow
): CauldronPool | null {
  const rawRow = row as Record<string, unknown>;
  const tokenCategory = findString(row, [
    'token_id',
    'token',
    'category',
    'tokenCategory',
  ]);
  const txHash = findString(row, ['txid', 'tx_hash', 'transaction', 'outpoint_txid']);
  const liveTxHash = findString(row, ['new_utxo_txid']);
  const withdrawPublicKeyHash = findHex(row, [
    'withdraw_pubkey_hash',
    'withdrawPublicKeyHash',
    'pkh',
    'owner_pkh',
  ]);
  const lockingBytecode =
    findHex(row, ['locking_bytecode', 'lockingBytecode']) ??
    (withdrawPublicKeyHash
      ? buildCauldronPoolV0LockingBytecode({ withdrawPublicKeyHash })
      : null);

  if (rawRow.is_withdrawn === true) {
    return null;
  }

  const effectiveTxHash = txHash || liveTxHash;

  if (!tokenCategory || !effectiveTxHash || !withdrawPublicKeyHash || !lockingBytecode) {
    return null;
  }

  const candidate = tryParseCauldronPoolFromUtxo(
    {
      tx_hash: effectiveTxHash,
      tx_pos: Number(
        rawRow.tx_pos ?? rawRow.vout ?? rawRow.output_index ?? rawRow.new_utxo_n ?? 0
      ),
      value: findBigInt(row, ['value', 'sats', 'amount', 'value_satoshis']),
      amount: findBigInt(row, ['value', 'sats', 'amount', 'value_satoshis']),
      token: {
        category: tokenCategory,
        amount: findBigInt(row, ['token_amount', 'amount_token', 'tokenAmount', 'tokens']),
      },
      lockingBytecode,
    },
    { withdrawPublicKeyHash }
  );

  if (!candidate) return null;

  return {
    ...candidate,
    ownerPublicKeyHash: findString(row, ['owner_pkh']) || null,
    ownerAddress: findString(row, ['owner_p2pkh_addr']) || null,
    poolId: findString(row, ['pool_id']) || null,
  };
}

export type CauldronWalletCreatedPoolCandidate = {
  txHash: string;
  outputIndex: number;
  tokenCategory: string;
};

function getCandidateOutputKey(txHash: string, outputIndex: number): string {
  return `${txHash}:${outputIndex}`;
}

export function collectWalletCreatedCauldronPoolCandidates(
  records: Array<
    Pick<OutboundTransactionRecord, 'txid' | 'rawTx' | 'spentOutpoints'>
  >
): CauldronWalletCreatedPoolCandidate[] {
  const spentOutpointSet = new Set(
    records.flatMap((record) =>
      record.spentOutpoints.map(
        (outpoint) => `${outpoint.tx_hash}:${outpoint.tx_pos}`
      )
    )
  );
  const candidates: CauldronWalletCreatedPoolCandidate[] = [];
  for (const record of records) {
    if (!record.rawTx) continue;
    let decoded;
    try {
      decoded = decodeTransaction(hexToBin(record.rawTx));
    } catch {
      continue;
    }
    if (typeof decoded === 'string') continue;

    const hasCauldronContractInput = decoded.inputs.some((input) => {
      const unlockingBytecode = input.unlockingBytecode;
      if (!(unlockingBytecode instanceof Uint8Array)) return false;
      return (
        extractCauldronPoolV0ParametersFromUnlockingBytecode(unlockingBytecode) !==
        null
      );
    });
    if (hasCauldronContractInput) continue;

    decoded.outputs.forEach((output, outputIndex) => {
      const lockingBytecode = output.lockingBytecode;
      if (!(lockingBytecode instanceof Uint8Array) || lockingBytecode.length === 0) {
        return;
      }

      const tokenCategory = normalizeTokenCategory(output.token?.category);
      if (!tokenCategory) return;

      const tokenAmount =
        typeof output.token?.amount === 'bigint'
          ? output.token.amount
          : typeof output.token?.amount === 'number'
            ? BigInt(Math.trunc(output.token.amount))
            : typeof output.token?.amount === 'string' &&
                output.token.amount.trim()
              ? BigInt(output.token.amount)
              : 0n;
      if (tokenAmount <= 0n) return;
      if (spentOutpointSet.has(getCandidateOutputKey(record.txid, outputIndex))) {
        return;
      }

      candidates.push({
        txHash: record.txid,
        outputIndex,
        tokenCategory,
      });
    });
  }

  return candidates;
}

export type NormalizedCauldronToken = {
  tokenId: string;
  symbol: string;
  name: string;
  decimals: number | null;
  imageUrl: string | null;
  tvlSats: number;
};

function parseTokenDecimals(value: unknown): number | null {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : NaN;
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.trunc(parsed));
}

function findWellKnownDecimals(entries: unknown): number | null {
  if (!Array.isArray(entries)) return null;

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const candidate = entry as Record<string, unknown>;
    const token =
      candidate.token && typeof candidate.token === 'object'
        ? (candidate.token as Record<string, unknown>)
        : null;

    const decimals =
      parseTokenDecimals(candidate.decimals) ??
      parseTokenDecimals(token?.decimals);
    if (decimals !== null) {
      return decimals;
    }
  }

  return null;
}

export function normalizeCauldronTokenRow(
  row: Record<string, unknown>
): NormalizedCauldronToken | null {
  const bcmr =
    row.bcmr && typeof row.bcmr === 'object'
      ? (row.bcmr as Record<string, unknown>)
      : null;
  const bcmrToken =
    bcmr?.token && typeof bcmr.token === 'object'
      ? (bcmr.token as Record<string, unknown>)
      : null;
  const bcmrUris =
    bcmr?.uris && typeof bcmr.uris === 'object'
      ? (bcmr.uris as Record<string, unknown>)
      : null;

  const tokenId =
    findString(row, ['token_id', 'category', 'id', 'token']) ||
    findString(bcmrToken ?? {}, ['category']);
  if (!tokenId) return null;

  const symbol =
    findString(row, ['display_symbol', 'symbol', 'ticker', 'token_symbol']) ||
    findString(bcmrToken ?? {}, ['symbol']) ||
    tokenId.slice(0, 6).toUpperCase();
  const name =
    findString(row, ['display_name', 'name', 'token_name']) ||
    findString(bcmr ?? {}, ['name']) ||
    symbol;
  const decimalsRaw =
    row.decimals ??
    row.token_decimals ??
    bcmrToken?.decimals ??
    findWellKnownDecimals(row.bcmr_well_known);
  const imageUrl =
    findString(row, ['icon', 'icon_url', 'image', 'image_url']) ||
    findString(bcmrUris ?? {}, ['icon']) ||
    null;
  const tvlSats =
    typeof row.tvl_sats === 'number'
      ? row.tvl_sats
      : typeof row.tvl_sats === 'string' && row.tvl_sats.trim()
        ? Number(row.tvl_sats)
        : 0;
  const totalTvlSats = Number.isFinite(tvlSats) ? tvlSats * 2 : 0;

  return {
    tokenId,
    symbol,
    name,
    decimals: parseTokenDecimals(decimalsRaw),
    imageUrl,
    tvlSats: totalTvlSats,
  };
}

export function rankCauldronPoolsBySpotPrice(
  pools: CauldronPool[],
  supplyTokenId: CauldronTokenId,
  demandTokenId: CauldronTokenId,
  rateDenominator = 10_000_000_000_000n
): CauldronPool[] {
  return [...pools].sort((left, right) => {
    const leftRate = calcCauldronPairRate(
      createCauldronPoolPair(left, supplyTokenId, demandTokenId),
      rateDenominator
    );
    const rightRate = calcCauldronPairRate(
      createCauldronPoolPair(right, supplyTokenId, demandTokenId),
      rateDenominator
    );
    return leftRate < rightRate ? -1 : leftRate > rightRate ? 1 : 0;
  });
}

export function analyzeCauldronDirectionLiquidity(
  pools: CauldronPool[],
  supplyTokenId: CauldronTokenId,
  demandTokenId: CauldronTokenId
): CauldronDirectionLiquidity {
  let executablePoolCount = 0;
  let maxSupply = 0n;
  let maxDemand = 0n;

  for (const pool of pools) {
    try {
      const pair = createCauldronPoolPair(pool, supplyTokenId, demandTokenId);
      const poolMaxDemand = pair.reserveB - pair.minReserveB;
      if (poolMaxDemand <= 0n) continue;
      const trade = calcCauldronTradeWithTargetDemand(pair, poolMaxDemand);
      if (!trade || trade.supply <= 0n || trade.demand <= 0n) continue;
      executablePoolCount += 1;
      maxSupply += trade.supply;
      maxDemand += trade.demand;
    } catch {
      continue;
    }
  }

  return {
    executablePoolCount,
    maxSupply,
    maxDemand,
  };
}

export function analyzeCauldronMarketLiquidity(
  pools: CauldronPool[],
  tokenId: string
): CauldronMarketLiquidity {
  return {
    bchToToken: analyzeCauldronDirectionLiquidity(
      pools,
      CAULDRON_NATIVE_BCH,
      tokenId
    ),
    tokenToBch: analyzeCauldronDirectionLiquidity(
      pools,
      tokenId,
      CAULDRON_NATIVE_BCH
    ),
  };
}

export function planBestSinglePoolTradeForTargetDemand(
  pools: CauldronPool[],
  supplyTokenId: CauldronTokenId,
  demandTokenId: CauldronTokenId,
  demandAmount: bigint
): { trade: CauldronPoolTrade; summary: CauldronTradeSummary } | null {
  let best: CauldronPoolTrade | null = null;

  for (const pool of pools) {
    let trade;
    try {
      const pair = createCauldronPoolPair(pool, supplyTokenId, demandTokenId);
      trade = calcCauldronTradeWithTargetDemand(pair, demandAmount);
    } catch {
      continue;
    }
    if (!trade) continue;

    const poolTrade = toCauldronPoolTrade(pool, supplyTokenId, demandTokenId, {
      supply: trade.supply,
      demand: trade.demand,
      tradeFee: trade.tradeFee,
    });

    if (!best || poolTrade.supply < best.supply) {
      best = poolTrade;
    }
  }

  if (!best) return null;
  return {
    trade: best,
    summary: summarizeCauldronTrade([best]) as CauldronTradeSummary,
  };
}

export function planBestSinglePoolTradeForTargetSupply(
  pools: CauldronPool[],
  supplyTokenId: CauldronTokenId,
  demandTokenId: CauldronTokenId,
  supplyAmount: bigint
): { trade: CauldronPoolTrade; summary: CauldronTradeSummary } | null {
  let best: CauldronPoolTrade | null = null;

  for (const pool of pools) {
    let trade;
    try {
      const pair = createCauldronPoolPair(pool, supplyTokenId, demandTokenId);
      trade = calcCauldronTradeWithTargetSupply(pair, supplyAmount);
    } catch {
      continue;
    }
    if (!trade) continue;

    const poolTrade = toCauldronPoolTrade(pool, supplyTokenId, demandTokenId, {
      supply: trade.supply,
      demand: trade.demand,
      tradeFee: trade.tradeFee,
    });

    if (!best || poolTrade.demand > best.demand) {
      best = poolTrade;
    }
  }

  if (!best) return null;
  return {
    trade: best,
    summary: summarizeCauldronTrade([best]) as CauldronTradeSummary,
  };
}

function planAggregatedTradeForTargetSupplyWithChunkCount(
  pools: CauldronPool[],
  supplyTokenId: CauldronTokenId,
  demandTokenId: CauldronTokenId,
  supplyAmount: bigint,
  chunkCount = 16
): { trades: CauldronPoolTrade[]; summary: CauldronTradeSummary } | null {
  if (supplyAmount <= 0n || pools.length === 0) return null;

  const workingPools = rankCauldronPoolsBySpotPrice(
    pools,
    supplyTokenId,
    demandTokenId
  ).map((pool) => ({
    key: formatPoolOutpoint(pool),
    pool,
    allocatedSupply: 0n,
    allocatedDemand: 0n,
    allocatedTradeFee: 0n,
  }));
  let remaining = supplyAmount;

  const findBestPoolAllocation = (increment: bigint) => {
    let best:
      | {
          index: number;
          trade: CauldronPoolTrade;
          marginalDemand: bigint;
          marginalTradeFee: bigint;
        }
      | null = null;

    for (let i = 0; i < workingPools.length; i += 1) {
      const current = workingPools[i];
      let trade;
      try {
        const pair = createCauldronPoolPair(current.pool, supplyTokenId, demandTokenId);
        trade = calcCauldronTradeWithTargetSupply(
          pair,
          current.allocatedSupply + increment
        );
      } catch {
        continue;
      }
      if (!trade) continue;
      const marginalDemand = trade.demand - current.allocatedDemand;
      const marginalTradeFee = trade.tradeFee - current.allocatedTradeFee;
      if (marginalDemand <= 0n || marginalTradeFee < 0n) continue;

      const poolTrade = toCauldronPoolTrade(
        current.pool,
        supplyTokenId,
        demandTokenId,
        {
          supply: trade.supply,
          demand: trade.demand,
          tradeFee: trade.tradeFee,
        }
      );

      if (
        !best ||
        marginalDemand > best.marginalDemand ||
        (marginalDemand === best.marginalDemand &&
          marginalTradeFee < best.marginalTradeFee)
      ) {
        best = { index: i, trade: poolTrade, marginalDemand, marginalTradeFee };
      }
    }

    return best;
  };

  const findBestFeasibleAllocation = (maxIncrement: bigint) => {
    let increment = maxIncrement;
    while (increment > 0n) {
      const best = findBestPoolAllocation(increment);
      if (best) return best;
      increment /= 2n;
    }
    return null;
  };

  for (let step = 0; step < chunkCount && remaining > 0n; step += 1) {
    const stepsLeft = BigInt(chunkCount - step);
    const chunk = remaining / stepsLeft > 0n ? remaining / stepsLeft : remaining;
    const best = findBestFeasibleAllocation(chunk);

    if (!best) {
      if (workingPools.every((entry) => entry.allocatedSupply === 0n)) return null;
      break;
    }

    remaining -= best.trade.supply - workingPools[best.index]!.allocatedSupply;
    workingPools[best.index] = {
      ...workingPools[best.index],
      allocatedSupply: best.trade.supply,
      allocatedDemand: best.trade.demand,
      allocatedTradeFee: best.trade.tradeFee,
    };
  }

  if (remaining > 0n) {
    const bestFallback = findBestFeasibleAllocation(remaining);

    if (!bestFallback) return null;
    workingPools[bestFallback.index] = {
      ...workingPools[bestFallback.index],
      allocatedSupply: bestFallback.trade.supply,
      allocatedDemand: bestFallback.trade.demand,
      allocatedTradeFee: bestFallback.trade.tradeFee,
    };
  }

  const trades = workingPools
    .filter((entry) => entry.allocatedSupply > 0n)
    .map((entry) =>
      toCauldronPoolTrade(entry.pool, supplyTokenId, demandTokenId, {
        supply: entry.allocatedSupply,
        demand: entry.allocatedDemand,
        tradeFee: entry.allocatedTradeFee,
      })
    );
  const summary = summarizeCauldronTrade(trades);
  if (!summary) return null;
  return { trades, summary };
}

function pickBetterTradePlan(
  left: { trades: CauldronPoolTrade[]; summary: CauldronTradeSummary } | null,
  right: { trades: CauldronPoolTrade[]; summary: CauldronTradeSummary } | null
): { trades: CauldronPoolTrade[]; summary: CauldronTradeSummary } | null {
  if (!left) return right;
  if (!right) return left;
  if (right.summary.demand > left.summary.demand) return right;
  if (right.summary.demand < left.summary.demand) return left;
  if (right.summary.tradeFee < left.summary.tradeFee) return right;
  if (right.summary.tradeFee > left.summary.tradeFee) return left;
  if (right.trades.length < left.trades.length) return right;
  return left;
}

function normalizeSinglePoolTradePlan(
  plan: { trade: CauldronPoolTrade; summary: CauldronTradeSummary } | null
): { trades: CauldronPoolTrade[]; summary: CauldronTradeSummary } | null {
  if (!plan) return null;
  return {
    trades: [plan.trade],
    summary: plan.summary,
  };
}

function planAggregatedTradeForTargetDemandWithChunkCount(
  pools: CauldronPool[],
  supplyTokenId: CauldronTokenId,
  demandTokenId: CauldronTokenId,
  demandAmount: bigint,
  chunkCount = 16
): { trades: CauldronPoolTrade[]; summary: CauldronTradeSummary } | null {
  if (demandAmount <= 0n || pools.length === 0) return null;

  const workingPools = rankCauldronPoolsBySpotPrice(
    pools,
    supplyTokenId,
    demandTokenId
  ).map((pool) => ({
    key: formatPoolOutpoint(pool),
    pool,
    allocatedSupply: 0n,
    allocatedDemand: 0n,
    allocatedTradeFee: 0n,
  }));
  let remaining = demandAmount;

  const findBestPoolAllocation = (increment: bigint) => {
    let best:
      | {
          index: number;
          trade: CauldronPoolTrade;
          marginalSupply: bigint;
          marginalTradeFee: bigint;
        }
      | null = null;

    for (let i = 0; i < workingPools.length; i += 1) {
      const current = workingPools[i];
      let trade;
      try {
        const pair = createCauldronPoolPair(current.pool, supplyTokenId, demandTokenId);
        trade = calcCauldronTradeWithTargetDemand(
          pair,
          current.allocatedDemand + increment
        );
      } catch {
        continue;
      }
      if (!trade) continue;

      const marginalSupply = trade.supply - current.allocatedSupply;
      const marginalTradeFee = trade.tradeFee - current.allocatedTradeFee;
      if (marginalSupply <= 0n || marginalTradeFee < 0n) continue;

      const poolTrade = toCauldronPoolTrade(
        current.pool,
        supplyTokenId,
        demandTokenId,
        {
          supply: trade.supply,
          demand: trade.demand,
          tradeFee: trade.tradeFee,
        }
      );

      if (
        !best ||
        marginalSupply < best.marginalSupply ||
        (marginalSupply === best.marginalSupply &&
          marginalTradeFee < best.marginalTradeFee)
      ) {
        best = { index: i, trade: poolTrade, marginalSupply, marginalTradeFee };
      }
    }

    return best;
  };

  const findBestFeasibleAllocation = (maxIncrement: bigint) => {
    let increment = maxIncrement;
    while (increment > 0n) {
      const best = findBestPoolAllocation(increment);
      if (best) return best;
      increment /= 2n;
    }
    return null;
  };

  for (let step = 0; step < chunkCount && remaining > 0n; step += 1) {
    const stepsLeft = BigInt(chunkCount - step);
    const chunk = remaining / stepsLeft > 0n ? remaining / stepsLeft : remaining;
    const best = findBestFeasibleAllocation(chunk);

    if (!best) {
      if (workingPools.every((entry) => entry.allocatedDemand === 0n)) return null;
      break;
    }

    remaining -= best.trade.demand - workingPools[best.index]!.allocatedDemand;
    workingPools[best.index] = {
      ...workingPools[best.index],
      allocatedSupply: best.trade.supply,
      allocatedDemand: best.trade.demand,
      allocatedTradeFee: best.trade.tradeFee,
    };
  }

  if (remaining > 0n) {
    const bestFallback = findBestFeasibleAllocation(remaining);

    if (!bestFallback) return null;
    workingPools[bestFallback.index] = {
      ...workingPools[bestFallback.index],
      allocatedSupply: bestFallback.trade.supply,
      allocatedDemand: bestFallback.trade.demand,
      allocatedTradeFee: bestFallback.trade.tradeFee,
    };
  }

  const trades = workingPools
    .filter((entry) => entry.allocatedDemand > 0n)
    .map((entry) =>
      toCauldronPoolTrade(entry.pool, supplyTokenId, demandTokenId, {
        supply: entry.allocatedSupply,
        demand: entry.allocatedDemand,
        tradeFee: entry.allocatedTradeFee,
      })
    );
  const summary = summarizeCauldronTrade(trades);
  if (!summary) return null;
  return { trades, summary };
}

export function planAggregatedTradeForTargetSupply(
  pools: CauldronPool[],
  supplyTokenId: CauldronTokenId,
  demandTokenId: CauldronTokenId,
  supplyAmount: bigint,
  chunkCount = 16
): { trades: CauldronPoolTrade[]; summary: CauldronTradeSummary } | null {
  if (supplyAmount <= 0n || pools.length === 0) return null;

  let best = normalizeSinglePoolTradePlan(
    planBestSinglePoolTradeForTargetSupply(
      pools,
      supplyTokenId,
      demandTokenId,
      supplyAmount
    )
  );

  const candidateChunkCounts = Array.from(
    new Set([1, 2, 4, 8, chunkCount, 16, 24, 32].filter((value) => value > 0))
  );

  for (const candidateChunkCount of candidateChunkCounts) {
    best = pickBetterTradePlan(
      best,
      planAggregatedTradeForTargetSupplyWithChunkCount(
        pools,
        supplyTokenId,
        demandTokenId,
        supplyAmount,
        candidateChunkCount
      )
    );
  }

  return best;
}

export function planAggregatedTradeForTargetDemand(
  pools: CauldronPool[],
  supplyTokenId: CauldronTokenId,
  demandTokenId: CauldronTokenId,
  demandAmount: bigint,
  chunkCount = 16
): { trades: CauldronPoolTrade[]; summary: CauldronTradeSummary } | null {
  if (demandAmount <= 0n || pools.length === 0) return null;

  let best = normalizeSinglePoolTradePlan(
    planBestSinglePoolTradeForTargetDemand(
      pools,
      supplyTokenId,
      demandTokenId,
      demandAmount
    )
  );

  const candidateChunkCounts = Array.from(
    new Set([1, 2, 4, 8, chunkCount, 16, 24, 32].filter((value) => value > 0))
  );

  for (const candidateChunkCount of candidateChunkCounts) {
    best = pickBetterTradePlan(
      best,
      planAggregatedTradeForTargetDemandWithChunkCount(
        pools,
        supplyTokenId,
        demandTokenId,
        demandAmount,
        candidateChunkCount
      )
    );
  }

  return best;
}

export async function fetchNormalizedCauldronPools(
  network: Network,
  client = new CauldronApiClient(network),
  tokenId?: string
): Promise<CauldronPool[]> {
  if (!tokenId) return [];

  const rows = await client.listActivePools({ tokenId });
  return rows
    .map((row) => normalizeCauldronPoolRow(row))
    .filter((pool): pool is CauldronPool => pool !== null);
}

function publicKeyHashHexFromAddress(address: string): string | null {
  try {
    return binToHex(derivePublicKeyHash(address)).toLowerCase();
  } catch {
    return null;
  }
}

export async function fetchCauldronDerivedWalletAddresses(
  walletId: number,
  network: Network,
  maxAddressIndex = 100,
  maxAccountIndex = 4
): Promise<Array<{ address: string; tokenAddress: string }>> {
  const results: Array<{ address: string; tokenAddress: string }> = [];
  for (let accountIndex = 0; accountIndex <= maxAccountIndex; accountIndex += 1) {
    let xpubs;
    try {
      xpubs = await KeyService.getWalletXpubs(walletId, accountIndex);
    } catch {
      continue;
    }

    for (const branchName of ['receive', 'change', 'defi'] as const) {
      const xpub = xpubs[branchName]?.trim();
      if (!xpub) continue;

      for (let index = 0; index < maxAddressIndex; index += 1) {
        const derived = deriveBchAddressFromHdPublicKey(
          network,
          xpub,
          BigInt(index)
        );
        if (!derived) continue;
        results.push({
          address: derived.address,
          tokenAddress: derived.tokenAddress,
        });
      }
    }
  }

  return results;
}

function dedupeCauldronPools(pools: CauldronPool[]): CauldronPool[] {
  const byKey = new Map<string, CauldronPool>();
  for (const pool of pools) {
    byKey.set(pool.poolId ?? formatPoolOutpoint(pool), pool);
  }
  return [...byKey.values()];
}

function normalizeHex(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function poolMatchesNftCommitment(pool: CauldronPool, utxo: UTXO): boolean {
  const commitment = normalizeHex(utxo.token?.nft?.commitment);
  if (!commitment) return false;

  const poolId = normalizeHex(pool.poolId);
  const outpointTxHash = normalizeHex(pool.txHash);
  const outpointIndexHex = pool.outputIndex.toString(16).padStart(8, '0');
  const outpointKey = `${outpointTxHash}${outpointIndexHex}`;

  return commitment === poolId || commitment === outpointTxHash || commitment === outpointKey;
}

function poolMatchesTokenNft(pool: CauldronPool, utxo: UTXO): boolean {
  return (
    utxo.token?.category === pool.output.tokenCategory && Boolean(utxo.token?.nft)
  );
}

export async function fetchNormalizedCauldronUserPools(
  network: Network,
  walletAddresses: Array<{ address: string; tokenAddress?: string }>,
  client = new CauldronApiClient(network)
): Promise<CauldronPool[]> {
  const publicKeyHashes = [...new Set(
    walletAddresses
      .flatMap((entry) => [entry.address, entry.tokenAddress].filter(Boolean) as string[])
      .map((address) => publicKeyHashHexFromAddress(address))
      .filter((value): value is string => Boolean(value))
  )];

  if (publicKeyHashes.length === 0) return [];

  const results = (
    await Promise.allSettled(
      publicKeyHashes.map((publicKeyHash) =>
        client.listActivePools({ publicKeyHash })
      )
    )
  ).flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));

  return dedupeCauldronPools(
    results
      .flat()
      .map((row) => normalizeCauldronPoolRow(row))
      .filter((pool): pool is CauldronPool => pool !== null)
  );
}

export function detectCauldronWalletPoolPositions(
  pools: CauldronPool[],
  tokenUtxos: UTXO[]
): CauldronWalletPoolPosition[] {
  return pools.flatMap((pool) => {
    const exactCommitmentMatches = tokenUtxos.filter((utxo) =>
      poolMatchesNftCommitment(pool, utxo)
    );
    const matchingTokenNfts = tokenUtxos.filter((utxo) => poolMatchesTokenNft(pool, utxo));
    const matchingNftUtxos =
      exactCommitmentMatches.length > 0 ? exactCommitmentMatches : matchingTokenNfts;

    if (matchingNftUtxos.length === 0 && !pool.ownerAddress && !pool.ownerPublicKeyHash) {
      return [];
    }

    return [
      {
        pool,
        ownerAddress: pool.ownerAddress ?? null,
        matchingNftUtxos,
        hasMatchingTokenNft: matchingNftUtxos.length > 0,
        detectionSource:
          exactCommitmentMatches.length > 0
            ? 'pool_nft_commitment'
            : matchingTokenNfts.length > 0
              ? 'token_nft_hint'
              : 'owner_pkh',
      },
    ];
  });
}

export function isBchTokenId(tokenId: CauldronTokenId): boolean {
  return tokenId === CAULDRON_NATIVE_BCH;
}

export function formatPoolOutpoint(pool: CauldronPool): string {
  return `${pool.txHash}:${pool.outputIndex}`;
}

export function formatPoolLockingBytecodeHex(pool: CauldronPool): string {
  return binToHex(pool.output.lockingBytecode);
}
