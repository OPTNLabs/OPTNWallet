import { binToHex, hexToBin } from '@bitauth/libauth';

import type { AddonSDK } from '../../../services/AddonsSDK';
import type { Network } from '../../../state/slices/networkSlice';
import type {
  CauldronActivePoolRow,
  CauldronPool,
  CauldronWalletPoolPosition,
} from '../../../services/cauldron';
import {
  getCauldronSubscriptionService,
  normalizeCauldronPoolRow,
  tryParseCauldronPoolFromUtxo,
} from '../../../services/cauldron';
import type { UTXO } from '../../../types/types';
import { parseSatoshis } from '../../../utils/binary';

type CauldronChainPoolSdk = Pick<AddonSDK, 'chain'>;

type CachedChainQuery = {
  expiresAt: number;
  rows: CauldronActivePoolRow[];
};

const CHAIN_QUERY_CACHE_TTL_MS = 10_000;
const chainQueryCacheByClient = new WeakMap<
  CauldronChainPoolSdk['chain'],
  Map<string, CachedChainQuery>
>();
const inFlightChainQueriesByClient = new WeakMap<
  CauldronChainPoolSdk['chain'],
  Map<string, Promise<CauldronActivePoolRow[]>>
>();

export function getUtxoOutpointKey(utxo: UTXO): string {
  return `${utxo.tx_hash}:${utxo.tx_pos}`;
}

export function getPoolOutpointKey(
  pool: Pick<CauldronPool, 'txHash' | 'outputIndex'>
): string {
  return `${stripChaingraphHexBytes(pool.txHash)}:${pool.outputIndex}`;
}

export function assertWalletInputsStillAvailable(
  currentWalletUtxos: UTXO[],
  selectedInputs: UTXO[],
  operationLabel: string,
  translate?: (
    key: string,
    fallback: string,
    values?: Record<string, string | number>
  ) => string
) {
  const currentOutpoints = new Set(currentWalletUtxos.map(getUtxoOutpointKey));
  const missingInputs = selectedInputs.filter(
    (utxo) => !currentOutpoints.has(getUtxoOutpointKey(utxo))
  );
  if (missingInputs.length > 0) {
    throw new Error(
      translate
        ? translate(
            'module.staleWalletInputs',
            '{operation} needs refreshed wallet inputs. One or more selected UTXOs are no longer spendable.',
            { operation: operationLabel }
          )
        : `${operationLabel} needs refreshed wallet inputs. One or more selected UTXOs are no longer spendable.`
    );
  }
}

export function getPoolSelectionId(pool: CauldronPool): string {
  return pool.poolId ?? `${pool.txHash}:${pool.outputIndex}`;
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

async function queryPoolsForTokenId(
  sdk: CauldronChainPoolSdk,
  lockingBytecodeHex: string,
  tokenId: string
): Promise<CauldronActivePoolRow[]> {
  const clientCache =
    chainQueryCacheByClient.get(sdk.chain) ??
    new Map<string, CachedChainQuery>();
  if (!chainQueryCacheByClient.has(sdk.chain)) {
    chainQueryCacheByClient.set(sdk.chain, clientCache);
  }

  const clientInFlight =
    inFlightChainQueriesByClient.get(sdk.chain) ??
    new Map<string, Promise<CauldronActivePoolRow[]>>();
  if (!inFlightChainQueriesByClient.has(sdk.chain)) {
    inFlightChainQueriesByClient.set(sdk.chain, clientInFlight);
  }

  const cacheKey = `${lockingBytecodeHex}:${tokenId}`;
  const cached = clientCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.rows;
  }

  const inFlight = clientInFlight.get(cacheKey);
  if (inFlight) return inFlight;

  const request = (async () => {
    const response = await sdk.chain.queryUnspentByLockingBytecode(
      lockingBytecodeHex,
      tokenId
    );
    const rows = Array.isArray(response?.data?.output)
      ? (response.data.output as CauldronActivePoolRow[])
      : [];
    clientCache.set(cacheKey, {
      expiresAt: Date.now() + CHAIN_QUERY_CACHE_TTL_MS,
      rows,
    });
    return rows;
  })();

  clientInFlight.set(cacheKey, request);
  try {
    return await request;
  } finally {
    clientInFlight.delete(cacheKey);
  }
}

async function resolvePoolsAgainstChain(args: {
  sdk: CauldronChainPoolSdk;
  pools: CauldronPool[];
}): Promise<{
  resolvedByOutpoint: Map<string, CauldronPool>;
  missingCount: number;
}> {
  const { sdk, pools } = args;
  const resolvedByOutpoint = new Map<string, CauldronPool>();
  let missingCount = 0;

  const uniquePools = [
    ...new Map(pools.map((pool) => [getPoolOutpointKey(pool), pool])).values(),
  ];

  const resolvedCandidates = await Promise.all(
    uniquePools.map(async (pool) => {
      const rows = await queryPoolsForTokenId(
        sdk,
        binToHex(pool.output.lockingBytecode),
        pool.output.tokenCategory
      );
      const outpointKey = getPoolOutpointKey(pool);
      const exactRow = rows.find(
        (row) => getChainRowOutpointKey(row) === outpointKey
      );
      return { exactRow, outpointKey, pool };
    })
  );

  for (const candidate of resolvedCandidates) {
    if (!candidate.exactRow) {
      missingCount += 1;
      continue;
    }

    resolvedByOutpoint.set(
      candidate.outpointKey,
      rehydratePoolFromChainRow(candidate.pool, candidate.exactRow) ??
        candidate.pool
    );
  }

  return { resolvedByOutpoint, missingCount };
}

function rehydratePoolFromChainRow(
  pool: CauldronPool,
  row: Record<string, unknown>
): CauldronPool | null {
  const tokenCategory =
    stripChaingraphHexBytes(
      row.token_category ??
        row.token_id ??
        row.token ??
        row.category ??
        row.tokenCategory
    ) || pool.output.tokenCategory;
  const amountSatoshis = parseSatoshis(
    row.value_satoshis ?? row.value ?? row.sats ?? row.amount
  );
  const tokenAmount = parseSatoshis(
    row.fungible_token_amount ??
      row.token_amount ??
      row.amount_token ??
      row.tokenAmount ??
      row.tokens
  );
  const parsed = tryParseCauldronPoolFromUtxo(
    {
      tx_hash: stripChaingraphHexBytes(
        row.transaction_hash ?? row.txid ?? row.tx_hash ?? row.new_utxo_txid
      ),
      tx_pos: Number(
        row.output_index ??
          row.tx_pos ??
          row.vout ??
          row.new_utxo_n ??
          pool.outputIndex
      ),
      value: amountSatoshis,
      amount: amountSatoshis,
      token: {
        category: tokenCategory,
        amount: tokenAmount,
      },
      lockingBytecode: getChainRowLockingBytecode(
        row,
        pool.output.lockingBytecode
      ),
    },
    pool.parameters
  );

  if (!parsed) return null;

  return {
    ...parsed,
    poolId: pool.poolId ?? null,
    ownerAddress: pool.ownerAddress ?? null,
    ownerPublicKeyHash: pool.ownerPublicKeyHash ?? null,
  };
}

export async function fetchCurrentQuotedPoolsFromChain(args: {
  sdk: CauldronChainPoolSdk;
  quotedPools: CauldronPool[];
}): Promise<{
  resolvedPools: CauldronPool[];
  missingQuotedPoolCount: number;
}> {
  const { sdk, quotedPools } = args;
  const { resolvedByOutpoint, missingCount } = await resolvePoolsAgainstChain({
    sdk,
    pools: quotedPools,
  });

  return {
    resolvedPools: quotedPools.flatMap((pool) => {
      const resolved = resolvedByOutpoint.get(getPoolOutpointKey(pool));
      return resolved ? [resolved] : [];
    }),
    missingQuotedPoolCount: missingCount,
  };
}

/**
 * Refresh the live liquidity behind a quoted route. A Cauldron pool may have
 * rolled to a successor outpoint while retaining the same locking bytecode;
 * merchant quoting can safely replan against that successor as long as the
 * buyer later performs the strict exact-outpoint validation.
 */
export async function fetchCurrentLiquidityPoolsFromChain(args: {
  sdk: CauldronChainPoolSdk;
  quotedPools: CauldronPool[];
}): Promise<{
  currentPools: CauldronPool[];
  missingQuotedPoolCount: number;
}> {
  const { sdk, quotedPools } = args;
  const uniquePools = [
    ...new Map(
      quotedPools.map((pool) => [getPoolOutpointKey(pool), pool])
    ).values(),
  ];
  const currentPoolsByOutpoint = new Map<string, CauldronPool>();
  let missingQuotedPoolCount = 0;

  const candidates = await Promise.all(
    uniquePools.map(async (pool) => {
      const rows = await queryPoolsForTokenId(
        sdk,
        binToHex(pool.output.lockingBytecode),
        pool.output.tokenCategory
      );
      const exactRow = rows.find(
        (row) => getChainRowOutpointKey(row) === getPoolOutpointKey(pool)
      );
      const rowsToRehydrate = exactRow ? [exactRow] : rows;
      const currentPools = rowsToRehydrate.flatMap((row) => {
        const refreshed = rehydratePoolFromChainRow(pool, row);
        if (refreshed) return [refreshed];
        return exactRow ? [pool] : [];
      });
      return { currentPools };
    })
  );

  for (const candidate of candidates) {
    if (candidate.currentPools.length === 0) {
      missingQuotedPoolCount += 1;
      continue;
    }
    for (const pool of candidate.currentPools) {
      currentPoolsByOutpoint.set(getPoolOutpointKey(pool), pool);
    }
  }

  return {
    currentPools: [...currentPoolsByOutpoint.values()],
    missingQuotedPoolCount,
  };
}

export async function fetchCurrentCauldronPools(args: {
  network: Network;
  tokenId: string;
}): Promise<CauldronPool[]> {
  const service = getCauldronSubscriptionService(args.network);
  let liveRows: CauldronActivePoolRow[] = [];
  let unsubscribe: (() => Promise<void>) | undefined;

  try {
    unsubscribe = await service.subscribe(args.tokenId, (rows) => {
      liveRows = rows;
    });
    return liveRows
      .map((row) => normalizeCauldronPoolRow(row))
      .filter((pool): pool is CauldronPool => pool !== null)
      .filter((pool) => pool.output.tokenCategory === args.tokenId);
  } finally {
    if (unsubscribe) await unsubscribe();
  }
}

export async function fetchCurrentQuotedPoolsFromCauldron(args: {
  network: Network;
  quotedPools: CauldronPool[];
}): Promise<{
  resolvedPools: CauldronPool[];
  missingQuotedPoolCount: number;
}> {
  const tokenId = args.quotedPools[0]?.output.tokenCategory ?? '';
  if (!tokenId) {
    return {
      resolvedPools: [],
      missingQuotedPoolCount: args.quotedPools.length,
    };
  }

  const currentPools = await fetchCurrentCauldronPools({
    network: args.network,
    tokenId,
  });
  const currentByOutpoint = new Map(
    currentPools.map((pool) => [getPoolOutpointKey(pool), pool])
  );
  const resolvedPools = args.quotedPools.flatMap((pool) => {
    const resolved = currentByOutpoint.get(getPoolOutpointKey(pool));
    return resolved ? [resolved] : [];
  });

  return {
    resolvedPools,
    missingQuotedPoolCount: args.quotedPools.length - resolvedPools.length,
  };
}

export async function fetchVisiblePoolsFromChain(args: {
  sdk: CauldronChainPoolSdk;
  visiblePools: CauldronPool[];
}): Promise<{
  confirmedPools: CauldronPool[];
  missingVisiblePoolCount: number;
}> {
  const { sdk, visiblePools } = args;
  const { resolvedByOutpoint: confirmedByOutpoint, missingCount } =
    await resolvePoolsAgainstChain({
      sdk,
      pools: visiblePools,
    });

  return {
    confirmedPools: visiblePools.flatMap((pool) => {
      const confirmed = confirmedByOutpoint.get(getPoolOutpointKey(pool));
      return confirmed ? [confirmed] : [];
    }),
    missingVisiblePoolCount: missingCount,
  };
}

function stripChaingraphHexBytes(value: unknown): string {
  if (!value) return '';
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/^\\x/i, '')
    .replace(/^0x/i, '');
}

function getChainRowOutpointKey(row: Record<string, unknown>): string {
  const txHash = stripChaingraphHexBytes(
    row.transaction_hash ?? row.txid ?? row.tx_hash ?? row.new_utxo_txid
  );
  const outputIndex = Number(
    row.output_index ?? row.tx_pos ?? row.vout ?? row.new_utxo_n ?? 0
  );
  return `${txHash}:${outputIndex}`;
}

export function resolveCurrentPoolForReview(
  reviewedPool: CauldronPool,
  visibleWalletPoolPositions: CauldronWalletPoolPosition[]
): CauldronPool {
  return (
    visibleWalletPoolPositions.find(
      (position) =>
        getPoolSelectionId(position.pool) === getPoolSelectionId(reviewedPool)
    )?.pool ?? reviewedPool
  );
}
