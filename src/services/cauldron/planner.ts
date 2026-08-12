import { binToHex, hexToBin } from '@bitauth/libauth';

import { Network } from '../../redux/networkSlice';
import { parseSatoshis } from '../../utils/binary';
import { derivePublicKeyHash } from '../../utils/derivePublicKeyHash';
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
  tryParseCauldronPoolFromUtxo,
} from './script';
import {
  CAULDRON_NATIVE_BCH,
  type CauldronPool,
  type CauldronPoolTrade,
  type CauldronTokenId,
  type CauldronTradeSummary,
  type CauldronWalletPoolPosition,
} from './types';
import type { UTXO } from '../../types/types';

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asHexBytes(value: unknown): Uint8Array | null {
  if (typeof value !== 'string') return null;
  const hex = value.trim().toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]+$/.test(hex) || hex.length % 2 !== 0) return null;
  return hexToBin(hex);
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
      value: Number(findBigInt(row, ['value', 'sats', 'amount', 'value_satoshis'])),
      amount: Number(findBigInt(row, ['value', 'sats', 'amount', 'value_satoshis'])),
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

function applyTradeToPool(
  pool: CauldronPool,
  trade: CauldronPoolTrade
): CauldronPool {
  return {
    ...pool,
    output: {
      ...pool.output,
      amountSatoshis:
        pool.output.amountSatoshis +
        (trade.supplyTokenId === CAULDRON_NATIVE_BCH ? trade.supply : -trade.demand),
      tokenAmount:
        pool.output.tokenAmount +
        (trade.supplyTokenId === CAULDRON_NATIVE_BCH ? -trade.demand : trade.supply),
    },
  };
}

export function planAggregatedTradeForTargetSupply(
  pools: CauldronPool[],
  supplyTokenId: CauldronTokenId,
  demandTokenId: CauldronTokenId,
  supplyAmount: bigint,
  chunkCount = 16
): { trades: CauldronPoolTrade[]; summary: CauldronTradeSummary } | null {
  if (supplyAmount <= 0n || pools.length === 0) return null;

  const workingPools = pools.map((pool) => ({
    key: formatPoolOutpoint(pool),
    pool,
  }));
  const trades: CauldronPoolTrade[] = [];
  let remaining = supplyAmount;

  for (let step = 0; step < chunkCount && remaining > 0n; step += 1) {
    const stepsLeft = BigInt(chunkCount - step);
    const chunk = remaining / stepsLeft > 0n ? remaining / stepsLeft : remaining;

    let best:
      | {
          index: number;
          trade: CauldronPoolTrade;
        }
      | null = null;

    for (let i = 0; i < workingPools.length; i += 1) {
      const current = workingPools[i];
      let trade;
      try {
        const pair = createCauldronPoolPair(
          current.pool,
          supplyTokenId,
          demandTokenId
        );
        trade = calcCauldronTradeWithTargetSupply(pair, chunk);
      } catch {
        continue;
      }
      if (!trade) continue;

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
        poolTrade.demand > best.trade.demand ||
        (poolTrade.demand === best.trade.demand &&
          poolTrade.tradeFee < best.trade.tradeFee)
      ) {
        best = { index: i, trade: poolTrade };
      }
    }

    if (!best) {
      if (trades.length === 0) return null;
      break;
    }

    trades.push(best.trade);
    remaining -= best.trade.supply;
    workingPools[best.index] = {
      ...workingPools[best.index],
      pool: applyTradeToPool(workingPools[best.index].pool, best.trade),
    };
  }

  if (remaining > 0n) {
    const fallback = planBestSinglePoolTradeForTargetSupply(
      workingPools.map((entry) => entry.pool),
      supplyTokenId,
      demandTokenId,
      remaining
    );
    if (!fallback) return null;
    trades.push(fallback.trade);
  }

  const summary = summarizeCauldronTrade(trades);
  if (!summary) return null;
  return { trades, summary };
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

  const results = await Promise.all(
    publicKeyHashes.map(async (publicKeyHash) =>
      client.listActivePools({ publicKeyHash })
    )
  );

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
