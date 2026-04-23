import { binToHex, hexToBin } from '@bitauth/libauth';

import type { AddonSDK } from '../../../services/AddonsSDK';
import type { CauldronActivePoolRow } from '../../../services/cauldron';
import type {
  CauldronPool,
  CauldronWalletPoolPosition,
} from '../../../services/cauldron';
import { tryParseCauldronPoolFromUtxo } from '../../../services/cauldron';
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
  return `${pool.txHash}:${pool.outputIndex}`;
}

export function assertWalletInputsStillAvailable(
  currentWalletUtxos: UTXO[],
  selectedInputs: UTXO[],
  operationLabel: string
) {
  const currentOutpoints = new Set(currentWalletUtxos.map(getUtxoOutpointKey));
  const missingInputs = selectedInputs.filter(
    (utxo) => !currentOutpoints.has(getUtxoOutpointKey(utxo))
  );
  if (missingInputs.length > 0) {
    throw new Error(
      `${operationLabel} needs refreshed wallet inputs. One or more selected UTXOs are no longer spendable.`
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
        row.output_index ?? row.tx_pos ?? row.vout ?? row.new_utxo_n ?? pool.outputIndex
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
  const resolvedByOutpoint = new Map<string, CauldronPool>();
  let missingQuotedPoolCount = 0;

  for (const pool of quotedPools) {
    const outpointKey = getPoolOutpointKey(pool);
    if (resolvedByOutpoint.has(outpointKey)) continue;

    const rows = await queryPoolsForTokenId(
      sdk,
      binToHex(pool.output.lockingBytecode),
      pool.output.tokenCategory
    );
    const exactRow = rows.find((row) => getChainRowOutpointKey(row) === outpointKey);

    if (!exactRow) {
      missingQuotedPoolCount += 1;
      continue;
    }

    resolvedByOutpoint.set(
      outpointKey,
      rehydratePoolFromChainRow(pool, exactRow) ?? pool
    );
  }

  return {
    resolvedPools: quotedPools.flatMap((pool) => {
      const resolved = resolvedByOutpoint.get(getPoolOutpointKey(pool));
      return resolved ? [resolved] : [];
    }),
    missingQuotedPoolCount,
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
  const confirmedByOutpoint = new Map<string, CauldronPool>();
  let missingVisiblePoolCount = 0;

  for (const pool of visiblePools) {
    const outpointKey = getPoolOutpointKey(pool);
    if (confirmedByOutpoint.has(outpointKey)) continue;

    const rows = await queryPoolsForTokenId(
      sdk,
      binToHex(pool.output.lockingBytecode),
      pool.output.tokenCategory
    );
    const exactRow = rows.find((row) => getChainRowOutpointKey(row) === outpointKey);

    if (!exactRow) {
      missingVisiblePoolCount += 1;
      continue;
    }

    confirmedByOutpoint.set(
      outpointKey,
      rehydratePoolFromChainRow(pool, exactRow) ?? pool
    );
  }

  return {
    confirmedPools: visiblePools.flatMap((pool) => {
      const confirmed = confirmedByOutpoint.get(getPoolOutpointKey(pool));
      return confirmed ? [confirmed] : [];
    }),
    missingVisiblePoolCount,
  };
}

function stripChaingraphHexBytes(value: unknown): string {
  if (!value) return '';
  return String(value).trim().toLowerCase().replace(/^\\x/i, '').replace(/^0x/i, '');
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
