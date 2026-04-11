import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSelector } from 'react-redux';
import { binToHex, hexToBin } from '@bitauth/libauth';

import type { AddonSDK } from '../../../services/AddonsSDK';
import type { AddonAppDefinition, AddonManifest } from '../../../types/addons';
import { selectCurrentNetwork } from '../../../redux/selectors/networkSelectors';
import type { RootState } from '../../../redux/store';
import useSharedTokenMetadata from '../../../hooks/useSharedTokenMetadata';
import { parseSatoshis } from '../../../utils/binary';
import { derivePublicKeyHash } from '../../../utils/derivePublicKeyHash';
import {
  buildCauldronPoolV0LockingBytecode,
  CAULDRON_NATIVE_BCH,
  CAULDRON_V0_VERSION,
  CauldronApiClient,
  type BuiltCauldronPoolDepositRequest,
  type BuiltCauldronPoolWithdrawRequest,
  buildCauldronPoolDepositRequest,
  buildCauldronTradeRequest,
  buildCauldronPoolWithdrawRequest,
  analyzeCauldronMarketLiquidity,
  detectCauldronWalletPoolPositions,
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
import type { UTXO } from '../../../types/types';
import {
  assertWalletInputsStillAvailable,
  fetchCurrentQuotedPoolsFromChain,
  fetchVisiblePoolsFromChain,
  getPoolSelectionId,
  resolveCurrentPoolForReview,
} from './preflight';
import {
  selectFundingUtxosByToken,
  selectLargestBchUtxos,
  sumSpendableBchBalance,
  sumSpendableTokenBalance,
} from './funding';
import { useSmoothResetTransition } from '../shared/useSmoothResetTransition';

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

function shortTokenId(tokenId: string): string {
  if (!tokenId) return '';
  return tokenId.length <= 12
    ? tokenId
    : `${tokenId.slice(0, 4)}...${tokenId.slice(-3)}`;
}

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

function aggregatePoolTrades(poolTrades: CauldronPoolTrade[]): CauldronPoolTrade[] {
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

function formatTimestamp(timestamp: number): string {
  try {
    return new Date(timestamp * 1000).toLocaleString();
  } catch {
    return String(timestamp);
  }
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

function formatApproxDisplayNumber(value: number, maxFractionDigits = 8): string {
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

function parseDecimalToAtomic(value: string, decimals: number): bigint | null {
  const normalized = value.trim();
  if (!normalized) return null;
  const pattern = new RegExp(`^\\d+(\\.\\d{0,${Math.max(0, decimals)}})?$`);
  if (!pattern.test(normalized)) return null;
  const [whole, frac = ''] = normalized.split('.');
  return (
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt((frac + '0'.repeat(decimals)).slice(0, decimals) || '0')
  );
}

function parseBchInputToSats(value: string): bigint | null {
  return parseDecimalToAtomic(value, 8);
}

function sanitizeDecimalInput(
  value: string,
  decimals: number,
  maxAtomic?: bigint | null
): string {
  let sanitized = value.replace(/,/g, '.').replace(/[^0-9.]/g, '');
  const firstDot = sanitized.indexOf('.');
  if (firstDot !== -1) {
    sanitized =
      sanitized.slice(0, firstDot + 1) +
      sanitized
        .slice(firstDot + 1)
        .replace(/\./g, '')
        .slice(0, Math.max(0, decimals));
  }

  if (sanitized.startsWith('.')) {
    sanitized = `0${sanitized}`;
  }

  const parsed = parseDecimalToAtomic(sanitized, decimals);
  if (maxAtomic != null && parsed != null && parsed > maxAtomic) {
    return formatTokenAmount(maxAtomic, decimals);
  }

  return sanitized;
}

function derivePoolTokenAmountFromSpotPrice(params: {
  bchAmountSats: bigint | null;
  tokenSpotPriceSats: number | null;
  decimals: number;
  maxTokenAmountAtomic?: bigint | null;
}): string {
  const { bchAmountSats, tokenSpotPriceSats, decimals, maxTokenAmountAtomic } = params;
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
  return cappedBchAmountSats > 0n ? formatTokenAmount(cappedBchAmountSats, 8) : '';
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
  return String(value).trim().toLowerCase().replace(/^\\x/i, '').replace(/^0x/i, '');
}

function parseWalletOwnedChainPools(params: {
  rows: Array<Record<string, unknown>>;
  ownerAddress: string;
  withdrawPublicKeyHash: Uint8Array;
}): CauldronPool[] {
  const { rows, ownerAddress, withdrawPublicKeyHash } = params;
  return rows.flatMap((row) => {
    const category = stripChaingraphHexBytes(row.token_category);
    const txHash = stripChaingraphHexBytes(row.transaction_hash);
    const outputIndex = Number(row.output_index ?? 0);
    const valueSatoshis = parseSatoshis(row.value_satoshis);
    const fungibleTokenAmount = parseSatoshis(row.fungible_token_amount);
    const lockingBytecode =
      typeof row.locking_bytecode === 'string' && row.locking_bytecode.trim()
        ? hexToBin(stripChaingraphHexBytes(row.locking_bytecode))
        : buildCauldronPoolV0LockingBytecode({ withdrawPublicKeyHash });

    if (!category || !txHash || fungibleTokenAmount <= 0n || valueSatoshis <= 0n) {
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
        ...parsed,
        ownerAddress,
        ownerPublicKeyHash: binToHex(withdrawPublicKeyHash),
      },
    ];
  });
}

async function fetchWalletOwnedPoolsFromChain(params: {
  sdk: AddonSDK;
  addresses: Array<{ address: string; tokenAddress?: string }>;
  tokenIds: string[];
}): Promise<CauldronWalletPoolPosition[]> {
  const { sdk, addresses, tokenIds } = params;
  if (tokenIds.length === 0 || addresses.length === 0) return [];

  const poolQueries = await Promise.all(
    addresses.flatMap((entry) => {
      let withdrawPublicKeyHash: Uint8Array;
      try {
        withdrawPublicKeyHash = derivePublicKeyHash(entry.address);
      } catch {
        return [];
      }

      const lockingBytecodeHex = binToHex(
        buildCauldronPoolV0LockingBytecode({ withdrawPublicKeyHash })
      );
      return tokenIds.map(async (tokenId) => {
        try {
          const response = await sdk.chain.queryUnspentByLockingBytecode(
            lockingBytecodeHex,
            tokenId
          );
          const rows = Array.isArray(response?.data?.output)
            ? (response.data.output as Array<Record<string, unknown>>)
            : [];
          return parseWalletOwnedChainPools({
            rows,
            ownerAddress: entry.address,
            withdrawPublicKeyHash,
          });
        } catch {
          return [];
        }
      });
    })
  );

  return dedupeWalletPoolPositions(
    poolQueries
      .flat()
      .flatMap((pool) => ({
        pool,
        ownerAddress: pool.ownerAddress ?? null,
        matchingNftUtxos: [],
        hasMatchingTokenNft: false,
        detectionSource: 'owner_pkh' as const,
      }))
  );
}

function fuzzyTokenMatchScore(query: string, symbol: string, name: string): number {
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

function formatLiquidityUsageWarning(
  label: string,
  usedBps: bigint
): string {
  return `${label} is using about ${(Number(usedBps) / 100).toFixed(2)}% of the currently executable market depth. Liquidity may move before you can unwind this position.`;
}

function shortAddress(value: string): string {
  if (!value) return '';
  return value.length <= 18
    ? value
    : `${value.slice(0, 10)}...${value.slice(-6)}`;
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

  const sortedBchUtxos = selectLargestBchUtxos(allUtxos);

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
    allUtxos,
    selectedTokenId,
    trades.reduce((sum, trade) => sum + trade.supply, 0n)
  );
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
    } catch {
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

  const tokenFunding = selectFundingUtxosByToken(
    allUtxos,
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
  const sortedBchUtxos = selectLargestBchUtxos(allUtxos).filter(
    (utxo) => !tokenFundingKeys.has(`${utxo.tx_hash}:${utxo.tx_pos}`)
  );

  for (let extraBch = 0; extraBch <= sortedBchUtxos.length; extraBch += 1) {
    const selected = [
      ...tokenFunding.selected,
      ...sortedBchUtxos.slice(0, extraBch),
    ];
    try {
      const walletInputs = await resolveCauldronFundingInputs(walletId, selected);
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
    } catch {
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
  const { walletId, allUtxos, pool, ownerAddress, recipientAddress, feeRate, userPrompt } =
    params;
  const ownerBchUtxo = selectLargestBchUtxos(allUtxos).find(
    (utxo) => utxo.address === ownerAddress
  );
  if (!ownerBchUtxo) {
    throw new Error('No BCH funding UTXO was found for the pool owner address.');
  }

  const [ownerInput] = await resolveCauldronFundingInputs(walletId, [ownerBchUtxo]);
  return buildCauldronPoolWithdrawRequest({
    pool,
    ownerInput,
    recipientAddress,
    feeRateSatsPerByte: feeRate,
    userPrompt,
  });
}

const CauldronSwapApp: React.FC<CauldronSwapAppProps> = ({ sdk, app }) => {
  const navigate = useNavigate();
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
  const [selectedTokenSpotPriceSats, setSelectedTokenSpotPriceSats] = useState<number | null>(
    null
  );
  const [showQuoteDetails, setShowQuoteDetails] = useState(true);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewWarningsAccepted, setReviewWarningsAccepted] = useState(false);
  const [reviewRouteExpanded, setReviewRouteExpanded] = useState(false);
  const [poolReview, setPoolReview] = useState<PoolReviewState | null>(null);
  const [walletPoolPositions, setWalletPoolPositions] = useState<
    CauldronWalletPoolPosition[]
  >([]);
  const [pendingWalletPoolPositions, setPendingWalletPoolPositions] = useState<
    CauldronWalletPoolPosition[]
  >([]);
  const [suppressedWalletPoolIds, setSuppressedWalletPoolIds] = useState<string[]>(
    []
  );
  const [selectedWalletPoolId, setSelectedWalletPoolId] = useState<
    string | null
  >(null);
  const [selectedWalletPoolHistory, setSelectedWalletPoolHistory] =
    useState<CauldronPoolHistoryResponse | null>(null);
  const [selectedWalletPoolApy, setSelectedWalletPoolApy] = useState<
    string | null
  >(null);
  const [loadingWalletPoolHistory, setLoadingWalletPoolHistory] =
    useState(false);
  const [poolCreateBchAmount, setPoolCreateBchAmount] = useState('0.01');
  const [poolCreateTokenAmount, setPoolCreateTokenAmount] = useState('');
  const [poolTokenAmountAuto, setPoolTokenAmountAuto] = useState(true);
  const [poolSyncAnchor, setPoolSyncAnchor] = useState<'bch' | 'token'>('bch');
  const [walletUtxos, setWalletUtxos] = useState<UTXO[]>([]);
  const { contentClassName, runSmoothReset } = useSmoothResetTransition();
  const [, setApiStatus] = useState<{
    tokensLoaded: number;
    poolsLoaded: number;
    tokenSource: 'api' | 'pools' | 'mixed';
    liveUpdatesEnabled: boolean;
    liveUpdatedAt: number | null;
  } | null>(null);

  const feeRate = 2n;
  const quoteActionsDisabled = false;
  const amountInputRef = useRef<HTMLInputElement | null>(null);
  const selectedToken = useMemo(
    () => tokens.find((token) => token.tokenId === selectedTokenId) ?? null,
    [tokens, selectedTokenId]
  );
  const metadataCategories = useMemo(
    () =>
      Array.from(
        new Set(
          [
            selectedTokenId,
            ...tokens.map((token) => token.tokenId),
            ...walletPoolPositions.map((position) => position.pool.output.tokenCategory),
          ].filter(Boolean)
        )
      ),
    [selectedTokenId, tokens, walletPoolPositions]
  );
  const sharedMetadata = useSharedTokenMetadata(
    metadataCategories
  );

  useEffect(() => {
    if (!message) return undefined;

    const timeoutId = window.setTimeout(() => {
      setMessage((current) => (current === message ? null : current));
    }, CAULDRON_MESSAGE_AUTO_DISMISS_MS);

    return () => window.clearTimeout(timeoutId);
  }, [message]);

  const filteredTokens = useMemo(() => {
    const query = tokenSearchQuery.trim();
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
  }, [sharedMetadata, tokenSearchQuery, tokens]);
  const selectedMetadata = selectedTokenId
    ? sharedMetadata[selectedTokenId]
    : undefined;

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const [addresses, walletUtxos] = await Promise.all([
          sdk.wallet.listAddresses(),
          sdk.utxos.listForWallet(),
        ]);
        const walletNftTokenIds = [
          ...new Set(
            walletUtxos.tokenUtxos
              .filter((utxo) => Boolean(utxo.token?.nft))
              .map((utxo) => utxo.token?.category?.toLowerCase())
              .filter((tokenId): tokenId is string => Boolean(tokenId))
          ),
        ];
        const apiClient = new CauldronApiClient(currentNetwork);
        const [userPools, nftCandidatePools] = await Promise.all([
          fetchNormalizedCauldronUserPools(
            currentNetwork,
            addresses,
            apiClient
          ),
          Promise.all(
            walletNftTokenIds.map((tokenId) =>
              fetchNormalizedCauldronPools(currentNetwork, apiClient, tokenId)
            )
          ),
        ]);
        const walletTokenIds = [
          ...new Set(
            walletUtxos.tokenUtxos
              .map((utxo) => utxo.token?.category?.toLowerCase())
              .filter((tokenId): tokenId is string => Boolean(tokenId))
          ),
        ];
        const chainDetectedPositions = await fetchWalletOwnedPoolsFromChain({
          sdk,
          addresses,
          tokenIds: walletTokenIds,
        });

        if (cancelled) return;

        setWalletUtxos(mergeWalletUtxoLists(walletUtxos));

        const poolMap = new Map<string, CauldronPool>();
        [...userPools, ...nftCandidatePools.flat()].forEach((pool) => {
          poolMap.set(
            pool.poolId ?? `${pool.txHash}:${pool.outputIndex}`,
            pool
          );
        });

        const detectedPositions = detectCauldronWalletPoolPositions(
          [...poolMap.values()],
          walletUtxos.tokenUtxos
        );
        setWalletPoolPositions(
          filterSuppressedWalletPoolPositions(
            dedupeWalletPoolPositions([
              ...detectedPositions,
              ...chainDetectedPositions,
            ]),
            suppressedWalletPoolIds
          )
        );
        setPendingWalletPoolPositions((current) =>
          current.filter(
            (position) =>
              !suppressedWalletPoolIds.includes(getPoolSelectionId(position.pool)) &&
              ![...detectedPositions, ...chainDetectedPositions].some(
                (detected) =>
                  getPoolSelectionId(detected.pool) === getPoolSelectionId(position.pool)
              )
          )
        );
      } catch {
        if (!cancelled) {
          setWalletPoolPositions([]);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [currentNetwork, sdk, suppressedWalletPoolIds]);

  useEffect(() => {
    let cancelled = false;
    const client = new CauldronApiClient(currentNetwork);

    void (async () => {
      try {
        setLoading(true);
        setMessage(null);
        const walletUtxos = await sdk.utxos.listForWallet();
        const walletNftTokenIds = [
          ...new Set(
            walletUtxos.tokenUtxos
              .filter((utxo) => Boolean(utxo.token?.nft))
              .map((utxo) => utxo.token?.category?.toLowerCase())
              .filter((tokenId): tokenId is string => Boolean(tokenId))
          ),
        ];
        const [tokenRows, walletTokenRows] = await Promise.all([
          client.listCachedTokens({
            limit: 500,
            by: 'score',
            order: 'desc',
          }),
          client.listCachedTokensByIds(walletNftTokenIds),
        ]);

        if (cancelled) return;

        const normalizedTokens = [...tokenRows, ...walletTokenRows]
          .map((row) => normalizeCauldronTokenRow(row))
          .filter((row): row is NormalizedCauldronToken => row !== null);
        const mergedTokens = mergeTokenCatalog(normalizedTokens, []);

        setWalletUtxos(mergeWalletUtxoLists(walletUtxos));
        setTokens(mergedTokens);
        setApiStatus({
          tokensLoaded: mergedTokens.length,
          poolsLoaded: 0,
          tokenSource: walletTokenRows.length > 0 ? 'mixed' : 'api',
          liveUpdatesEnabled: false,
          liveUpdatedAt: null,
        });
        if (!selectedTokenId && mergedTokens[0]?.tokenId) {
          setSelectedTokenId(mergedTokens[0].tokenId);
        }
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
  }, [currentNetwork, sdk, selectedTokenId]);

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
        const client = new CauldronApiClient(currentNetwork);
        const normalizedPools = await fetchNormalizedCauldronPools(
          currentNetwork,
          client,
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
  }, [currentNetwork, selectedTokenId]);

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
        const client = new CauldronApiClient(currentNetwork);
        const payload = await client.getCurrentPrice(selectedTokenId);
        const price =
          typeof payload.price === 'number'
            ? payload.price
            : typeof payload.price === 'string'
              ? Number(payload.price)
              : NaN;
        if (!cancelled) {
          setSelectedTokenSpotPriceSats(Number.isFinite(price) && price > 0 ? price : null);
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
  }, [currentNetwork, direction, selectedTokenId]);

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
      dedupePoolsBySelectionId([
        ...(livePools.length > 0 ? livePools : pools),
        ...walletPoolPositions.map((position) => position.pool),
      ]).filter(
        (pool) => pool.output.tokenCategory === selectedTokenId
      ),
    [livePools, pools, selectedTokenId, walletPoolPositions]
  );
  const visibleWalletPoolPositions = useMemo(() => {
    const combinedPositions = filterSuppressedWalletPoolPositions(
      dedupeWalletPoolPositions([
        ...walletPoolPositions,
        ...pendingWalletPoolPositions,
      ]),
      suppressedWalletPoolIds
    );
    if (!selectedTokenId) return combinedPositions;
    const filtered = combinedPositions.filter(
      (position) => position.pool.output.tokenCategory === selectedTokenId
    );
    return filtered.length > 0 ? filtered : combinedPositions;
  }, [
    pendingWalletPoolPositions,
    selectedTokenId,
    suppressedWalletPoolIds,
    walletPoolPositions,
  ]);
  const selectedWalletPoolPosition = useMemo(
    () =>
      visibleWalletPoolPositions.find(
        (position) => getPoolSelectionId(position.pool) === selectedWalletPoolId
      ) ?? null,
    [selectedWalletPoolId, visibleWalletPoolPositions]
  );

  const effectiveSymbol =
    selectedMetadata?.symbol || selectedToken?.symbol || 'TOKEN';
  const effectiveName =
    selectedMetadata?.name || selectedToken?.name || selectedTokenId;
  const effectiveDecimals =
    selectedMetadata?.decimals ?? selectedToken?.decimals ?? 0;
  const tokenIconUri =
    selectedMetadata?.iconUri || selectedToken?.imageUrl || null;
  const selectedPoolToken = selectedWalletPoolPosition
    ? tokens.find(
        (token) =>
          token.tokenId === selectedWalletPoolPosition.pool.output.tokenCategory
      ) ?? null
    : null;
  const selectedPoolSymbol = selectedPoolToken?.symbol ?? effectiveSymbol;
  const selectedPoolName = selectedPoolToken?.name ?? effectiveName;
  const selectedPoolDecimals = selectedPoolToken?.decimals ?? effectiveDecimals;
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
    if (!selectedTokenId && walletPoolPositions[0]?.pool.output.tokenCategory) {
      setSelectedTokenId(walletPoolPositions[0].pool.output.tokenCategory);
    }
  }, [walletPoolPositions, selectedTokenId]);

  useEffect(() => {
    setPoolTokenAmountAuto(true);
    setPoolSyncAnchor('bch');
  }, [selectedTokenId]);

  useEffect(() => {
    if (
      selectedWalletPoolId &&
      !visibleWalletPoolPositions.some(
        (position) => getPoolSelectionId(position.pool) === selectedWalletPoolId
      )
    ) {
      setSelectedWalletPoolId(null);
      setSelectedWalletPoolHistory(null);
    }
  }, [selectedWalletPoolId, visibleWalletPoolPositions]);

  useEffect(() => {
    let cancelled = false;

    if (!selectedWalletPoolId || !selectedWalletPoolPosition?.pool.poolId) {
      setSelectedWalletPoolHistory(null);
      setSelectedWalletPoolApy(null);
      return () => {
        cancelled = true;
      };
    }

    void (async () => {
      try {
        setLoadingWalletPoolHistory(true);
        const client = new CauldronApiClient(currentNetwork);
        const history = await client.getPoolHistory(
          selectedWalletPoolPosition.pool.poolId
        );
        const apyResponse = await client
          .getAggregatedApy({
            poolId: selectedWalletPoolPosition.pool.poolId,
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
  }, [currentNetwork, selectedWalletPoolId, selectedWalletPoolPosition]);

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
      selectedTokenId ? sumSpendableTokenBalance(walletUtxos, selectedTokenId) : 0n,
    [selectedTokenId, walletUtxos]
  );
  const swapBchMaxInputSats =
    spendableBchBalanceSats > 2_000n ? spendableBchBalanceSats - 2_000n : 0n;
  const poolBchMaxInputSats =
    spendableBchBalanceSats > 2_500n ? spendableBchBalanceSats - 2_500n : 0n;
  const payMaxAtomic =
    direction === 'bch_to_token'
      ? swapBchMaxInputSats
      : spendableTokenBalanceAtomic;
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
          direction === 'bch_to_token'
            ? CAULDRON_NATIVE_BCH
            : selectedTokenId,
          direction === 'bch_to_token'
            ? selectedTokenId
            : CAULDRON_NATIVE_BCH,
          parsedAmount
        ) ?? null;
      return {
        plan: planned
          ? {
              ...planned,
              trades: aggregatePoolTrades(planned.trades),
            }
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
    if (!selectedTokenSpotPriceSats || !inputAmountNumber || inputAmountNumber <= 0) {
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
    if (totalSupply <= 0n || totalDemand <= 0n) return spotPreview?.rateLabel ?? null;
    if (direction === 'bch_to_token') {
      const unitPrice =
        (totalSupply * 10n ** BigInt(effectiveDecimals)) / totalDemand;
      return `1 ${effectiveSymbol} = ${formatCompactBchAmount(unitPrice)}`;
    }
    const unitPrice =
      (totalDemand * 10n ** BigInt(effectiveDecimals)) / totalSupply;
    return `1 BCH = ${formatTokenAmount(unitPrice, effectiveDecimals)} ${effectiveSymbol}`;
  }, [direction, effectiveDecimals, effectiveSymbol, previewPlan, quote, spotPreview]);
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
    parsedAmount &&
      parsedAmount > 0n &&
      (direction === 'bch_to_token'
        ? parsedAmount > swapBchMaxInputSats
        : parsedAmount > spendableTokenBalanceAtomic)
  );
  const canSwap = Boolean(
    selectedTokenId &&
      parsedAmount &&
      parsedAmount > 0n &&
      !swapAmountExceedsBalance
  );
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
      return quote ? formatUnsignedPercentValue(Number(feeRatioBps) / 100) : 'Get quote';
    }

    const impact =
      Math.abs(effectiveAtomicPriceSats - selectedTokenSpotPriceSats) /
      selectedTokenSpotPriceSats;
    return formatUnsignedPercentValue(impact * 100);
  }, [effectiveAtomicPriceSats, feeRatioBps, quote, selectedTokenSpotPriceSats]);
  const previewTradeCount =
    quote?.trades.length ?? previewPlan?.trades.length ?? 0;
  const previewedRouteRows = quote?.trades ?? [];
  const hiddenRouteRows = previewedRouteRows.slice(2);
  const hiddenRouteCount = hiddenRouteRows.length;
  const hiddenRouteDemand = hiddenRouteRows.reduce(
    (total, trade) => total + trade.demand,
    0n
  );
  const swapPayBalanceLabel =
    direction === 'bch_to_token'
      ? `${formatBchAmount(spendableBchBalanceSats)} BCH in wallet`
      : `${formatTokenAmount(spendableTokenBalanceAtomic, effectiveDecimals)} ${effectiveSymbol} in wallet`;
  const poolBchBalanceLabel = `${formatBchAmount(spendableBchBalanceSats)} BCH available`;
  const poolTokenBalanceLabel = `${formatTokenAmount(spendableTokenBalanceAtomic, effectiveDecimals)} ${effectiveSymbol} available`;
  const marketRatioCaption =
    selectedTokenSpotPriceSats && parsedPoolCreateBchAmount && parsedPoolCreateBchAmount > 0n
      ? `Market ratio targets about ${autoPoolTokenAmount || '0'} ${effectiveSymbol} for ${formatBchAmount(parsedPoolCreateBchAmount)} BCH.${autoPoolTokenAmountWasCapped ? ` The pair was reduced to stay within your available ${effectiveSymbol} balance.` : ''}${autoPoolBchAmountWasCapped ? ' The BCH side was reduced to stay within your spendable BCH balance.' : ''}`
      : selectedTokenSpotPriceSats
        ? 'Enter a BCH amount to auto-fill the token side from the live market price.'
        : 'Live market ratio is unavailable right now. Enter the token side manually.';

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
  ]);

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
            TVL {formatCompactBchAmount(BigInt(Math.trunc(selectedToken.tvlSats)))}
          </div>
        ) : null}
      </div>
      <span className="text-sm wallet-muted">⌄</span>
    </button>
  );

  const assertSwapAmountWithinBalance = (amountAtomic: bigint) => {
    if (direction === 'bch_to_token') {
      if (amountAtomic > swapBchMaxInputSats) {
        throw new Error(
          'Swap amount exceeds your spendable BCH balance after the network fee buffer.'
        );
      }
      return;
    }

    if (amountAtomic > spendableTokenBalanceAtomic) {
      throw new Error(`Swap amount exceeds your available ${effectiveSymbol} balance.`);
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

  const syncPoolFromBchAmount = (nextBchAmount: string) => {
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
  };

  const syncPoolFromTokenAmount = (nextTokenAmount: string) => {
    setPoolCreateTokenAmount(nextTokenAmount);
    if (!selectedTokenSpotPriceSats || !nextTokenAmount.trim()) {
      return;
    }

    const nextTokenAtomic = parseDecimalToAtomic(nextTokenAmount, effectiveDecimals);
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
  };

  const resetSwapComposer = () => {
    setAmount(direction === 'bch_to_token' ? '0.001' : '1');
    setQuote(null);
    setReviewOpen(false);
    setReviewWarningsAccepted(false);
    setReviewRouteExpanded(false);
  };

  const resetPoolComposer = () => {
    setPoolCreateBchAmount('0.01');
    setPoolCreateTokenAmount('');
    setPoolReview(null);
    setSelectedWalletPoolId(null);
    setPoolTokenAmountAuto(true);
    setPoolSyncAnchor('bch');
  };

  const resetCauldronViewState = async (suppressedPoolIds = suppressedWalletPoolIds) => {
    await refreshCauldronState(suppressedPoolIds);
    resetSwapComposer();
    resetPoolComposer();
    setActiveView('swap');
    setSelectedWalletPoolHistory(null);
    setSelectedWalletPoolApy(null);
    setTokenSearchQuery('');
  };

  const handleQuote = async () => {
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

      const { confirmedPools, missingVisiblePoolCount } =
        await fetchVisiblePoolsFromChain({
          sdk,
          visiblePools: tokenPools,
        });
      if (confirmedPools.length === 0) {
        throw new Error(
          'No executable Cauldron pools are currently confirmed on chain for this token. Refresh and try again.'
        );
      }

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
            direction === 'bch_to_token'
              ? 'This buy'
              : 'This sell',
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
        } else if (planned.summary.demand > reverseDirectionLiquidity.maxSupply) {
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
        } else if (planned.summary.demand > reverseDirectionLiquidity.maxSupply) {
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

      setQuote({
        trades: aggregatedTrades,
        totalSupply: planned.summary.supply,
        totalDemand: planned.summary.demand,
        estimatedFeeSatoshis: built.estimatedFeeSatoshis,
        minReceive: applySlippage(planned.summary.demand, slippage),
        built,
        warnings,
      });
      setReviewWarningsAccepted(false);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : 'Unable to quote Cauldron swap'
      );
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

      await runSmoothReset(resetCauldronViewState);
      setMessage(
        result.broadcastState === 'submitted'
          ? `Swap handoff pending visibility: ${result.txid}. Keep the txid and avoid sending it again until it appears in history.`
          : `Swap broadcasted: ${result.txid}`
      );
    } catch (error) {
      await runSmoothReset(async () => {
        resetSwapComposer();
        setActiveView('swap');
        setSelectedWalletPoolId(null);
        setPoolReview(null);
      });
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
    setReviewRouteExpanded(false);
    setReviewWarningsAccepted(false);
    setReviewOpen(true);
  };

  const refreshCauldronState = async (
    suppressedPoolIds = suppressedWalletPoolIds
  ) => {
    const addresses = await sdk.wallet.listAddresses();
    await Promise.allSettled(
      addresses.map((entry) => sdk.utxos.refreshAndStore(entry.address))
    );

    if (selectedTokenId) {
      const refreshedPools = await fetchNormalizedCauldronPools(
        currentNetwork,
        undefined,
        selectedTokenId
      );
      setPools(refreshedPools);
      setLivePools([]);
    }

    const walletUtxos = await sdk.utxos.listForWallet();
    setWalletUtxos(mergeWalletUtxoLists(walletUtxos));
    const walletNftTokenIds = [
      ...new Set(
        walletUtxos.tokenUtxos
          .filter((utxo) => Boolean(utxo.token?.nft))
          .map((utxo) => utxo.token?.category?.toLowerCase())
          .filter((tokenId): tokenId is string => Boolean(tokenId))
      ),
    ];
    const client = new CauldronApiClient(currentNetwork);
    const [userPools, nftCandidatePools] = await Promise.all([
      fetchNormalizedCauldronUserPools(currentNetwork, addresses, client),
      walletNftTokenIds.length > 0
        ? Promise.all(
            walletNftTokenIds.map((tokenId) =>
              fetchNormalizedCauldronPools(currentNetwork, client, tokenId)
            )
          )
        : Promise.resolve([] as CauldronPool[][]),
    ]);
    const walletTokenIds = [
      ...new Set(
        walletUtxos.tokenUtxos
          .map((utxo) => utxo.token?.category?.toLowerCase())
          .filter((tokenId): tokenId is string => Boolean(tokenId))
      ),
    ];
    const chainDetectedPositions = await fetchWalletOwnedPoolsFromChain({
      sdk,
      addresses,
      tokenIds: walletTokenIds,
    });

    const poolMap = new Map<string, CauldronPool>();
    [...userPools, ...nftCandidatePools.flat()].forEach((pool) => {
      poolMap.set(getPoolSelectionId(pool), pool);
    });
    const detectedPositions = detectCauldronWalletPoolPositions(
      [...poolMap.values()],
      walletUtxos.tokenUtxos
    );
    setWalletPoolPositions(
      filterSuppressedWalletPoolPositions(
        dedupeWalletPoolPositions([...detectedPositions, ...chainDetectedPositions]),
        suppressedPoolIds
      )
    );
    setPendingWalletPoolPositions((current) =>
      current.filter(
        (position) =>
          !suppressedPoolIds.includes(getPoolSelectionId(position.pool)) &&
          ![...detectedPositions, ...chainDetectedPositions].some(
            (detected) =>
              getPoolSelectionId(detected.pool) === getPoolSelectionId(position.pool)
          )
      )
    );
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
        throw new Error(`Enter a valid ${effectiveSymbol} amount for the pool.`);
      }
      assertPoolCreateAmountsWithinBalance(
        parsedPoolCreateBchAmount,
        parsedPoolCreateTokenAmount
      );

      const addresses = await sdk.wallet.listAddresses();
      const ownerAddress = addresses[0]?.tokenAddress || addresses[0]?.address;
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
        error instanceof Error ? error.message : 'Unable to create Cauldron pool'
      );
    }
  };

  const handleWithdrawPool = async () => {
    try {
      setMessage(null);

      if (!selectedWalletPoolPosition) {
        throw new Error('Select a pool first.');
      }

      const addresses = await sdk.wallet.listAddresses();
      const ownerAddress = addresses.find((entry) => {
        try {
          return (
            binToHex(derivePublicKeyHash(entry.address)).toLowerCase() ===
            binToHex(
              selectedWalletPoolPosition.pool.parameters.withdrawPublicKeyHash
            ).toLowerCase()
          );
        } catch {
          return false;
        }
      })?.address;
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
      setPoolReview({
        kind: 'withdraw',
        built,
        pool: selectedWalletPoolPosition.pool,
      });
      setSelectedWalletPoolId(null);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : 'Unable to withdraw Cauldron pool'
      );
    }
  };

  const handleConfirmPoolReview = async () => {
    if (!poolReview) return;

    try {
      setSubmitting(true);
      setMessage(null);

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
        const ownerAddress = addresses[0]?.tokenAddress || addresses[0]?.address;
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
        setPendingWalletPoolPositions((current) =>
          dedupeWalletPoolPositions([
            {
              pool: createdPool,
              ownerAddress,
              matchingNftUtxos: [],
              hasMatchingTokenNft: false,
              detectionSource: 'owner_pkh',
            },
            ...current,
          ])
        );

        await runSmoothReset(resetCauldronViewState);
        setMessage(`Pool submitted: ${result.txid}`);
        return;
      }

      const addresses = await sdk.wallet.listAddresses();
      const ownerAddress = addresses.find((entry) => {
        try {
          return (
            binToHex(derivePublicKeyHash(entry.address)).toLowerCase() ===
            binToHex(poolReview.pool.parameters.withdrawPublicKeyHash).toLowerCase()
          );
        } catch {
          return false;
        }
      })?.address;
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

      await runSmoothReset(() =>
        resetCauldronViewState(nextSuppressedWalletPoolIds)
      );
      setMessage(`Pool withdrawal submitted: ${result.txid}`);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : 'Unable to submit Cauldron pool transaction'
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="container relative mx-auto flex h-full min-h-0 max-w-md flex-col overflow-hidden px-4 pb-3 pt-3 wallet-page">
      <div className="flex-none">
        <div className="flex justify-center">
          <img
            src="/assets/images/cauldron-header-logo.png"
            alt="Cauldron"
            className="h-auto w-full max-w-[220px] object-contain"
          />
        </div>
        <div className="mt-3 flex items-center justify-between gap-3">
          <h1 className="min-w-0 truncate text-xl font-bold tracking-[-0.02em] wallet-text-strong">
            {app.name} (Demo)
          </h1>
          <button
            type="button"
            onClick={() => navigate('/apps')}
            className="wallet-btn-danger px-4 py-2 text-sm"
          >
            Go Back
          </button>
        </div>
      </div>

      <div className={`flex min-h-0 flex-1 flex-col pt-3 ${contentClassName}`}>
        {message ? (
          <div className="pointer-events-none absolute left-4 right-4 top-[6.5rem] z-20">
            <div className="wallet-warning-panel rounded-2xl px-4 py-3 text-sm shadow-lg">
              {message}
            </div>
          </div>
        ) : null}

        <div className="wallet-card mt-3 flex-none p-1 first:mt-0">
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setActiveView('swap')}
              className={segmentedBaseClass}
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
              className={segmentedBaseClass}
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

        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain touch-pan-y pr-1 pt-3">
          {activeView === 'swap' ? (
            <div className="space-y-3 pb-2">
              <div className="wallet-card p-3">
                <div className="space-y-2">
                  <div
                    className="rounded-[22px] border px-3 py-3"
                    style={{
                      backgroundColor: 'var(--wallet-surface)',
                      borderColor: 'var(--wallet-border)',
                    }}
                  >
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <span className="text-sm font-semibold wallet-muted">
                        You pay
                      </span>
                      <div className="flex items-center gap-2">
                        <span className="text-xs wallet-muted opacity-80">
                          {payBalanceCaption}
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            setAmount(
                              direction === 'bch_to_token'
                                ? formatTokenAmount(swapBchMaxInputSats, 8)
                                : formatTokenAmount(
                                    spendableTokenBalanceAtomic,
                                    effectiveDecimals
                                  )
                            );
                            setQuote(null);
                          }}
                          className="wallet-btn-secondary px-2.5 py-1 text-[11px]"
                          disabled={loading || submitting || payMaxAtomic <= 0n}
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
                      {direction === 'bch_to_token' ? (
                        renderAssetBadge('BCH', 'Wallet', null, 'bch')
                      ) : (
                        renderTokenPickerTrigger(true)
                      )}
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
                              direction === 'bch_to_token' ? 8 : effectiveDecimals;
                            const nextAmount = sanitizeDecimalInput(
                              event.target.value,
                              decimals,
                              payMaxAtomic
                            );
                            if (
                              payMaxAtomic > 0n &&
                              nextAmount !== event.target.value
                            ) {
                              setMessage(
                                direction === 'bch_to_token'
                                  ? 'Amount was adjusted to stay within your spendable BCH balance.'
                                  : `Amount was adjusted to stay within your ${effectiveSymbol} balance.`
                              );
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
                        <span className="pb-0.5 text-base font-semibold wallet-muted">
                          {payUnitLabel}
                        </span>
                      </div>
                      <div className="mt-2 text-xs wallet-muted">
                        Available: {swapPayBalanceLabel}
                        {direction === 'bch_to_token'
                          ? ' (small network fee buffer reserved)'
                          : ''}
                      </div>
                      {swapAmountExceedsBalance ? (
                        <div className="mt-1 text-xs text-amber-200">
                          {direction === 'bch_to_token'
                            ? 'Swap amount exceeds your spendable BCH balance after the fee buffer.'
                            : `Swap amount exceeds your available ${effectiveSymbol} balance.`}
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
                      <span className="text-sm font-semibold wallet-muted">
                        You receive
                      </span>
                      <span className="text-xs wallet-muted opacity-80">
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
                      {direction === 'bch_to_token' ? (
                        renderTokenPickerTrigger(true)
                      ) : (
                        renderAssetBadge('BCH', 'Wallet', null, 'bch')
                      )}
                    </div>
                    <div className="mt-3">
                      <div className="flex items-end gap-2">
                        <div className="w-auto text-3xl font-bold leading-none wallet-text-strong">
                          {outputDisplayValue}
                        </div>
                        <span className="pb-0.5 text-base font-semibold wallet-muted">
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
                      quote ? handleReviewSwap : () => void handleQuote()
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
                  Slippage sets the minimum receive threshold. After you get a
                  quote, OPTN refreshes the live pools and stops the swap if the
                  new quote would deliver less than your protected minimum.
                </div>
              </div>

              {quoteRateLabel ? (
                <div className="wallet-card p-3">
                  <button
                    type="button"
                    onClick={() => setShowQuoteDetails((current) => !current)}
                    className="flex w-full items-center justify-between gap-3 text-left text-sm wallet-text-strong"
                  >
                    <span>{quoteRateLabel}</span>
                    <span className="wallet-muted">
                      {showQuoteDetails ? '⌃' : '⌄'}
                    </span>
                  </button>

                  {showQuoteDetails ? (
                    <div className="mt-4 space-y-2 text-sm">
                      <div className="flex items-center justify-between gap-3">
                        <span className="wallet-muted">
                          Liquidity provider fee (0.3%)
                        </span>
                        <span className="wallet-text-strong">
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
                        <span className="wallet-muted">
                          Cauldron platform fee (0.0%)
                        </span>
                        <span className="wallet-text-strong">0 BCH</span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span className="wallet-muted">Network fee</span>
                        <span className="wallet-text-strong">
                          {quote
                            ? formatCompactBchAmount(quote.estimatedFeeSatoshis)
                            : 'Get quote'}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span className="wallet-muted">Minimum receive</span>
                        <span className="wallet-text-strong">
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
                        <span className="wallet-muted">Pools used</span>
                        <span className="wallet-text-strong">
                          {previewTradeCount}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span className="wallet-muted">Price impact</span>
                        <span className="wallet-text-strong">
                          {priceImpactLabel}
                        </span>
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : previewError ? (
                <div className="px-1 text-xs text-amber-200">
                  {previewError}
                </div>
              ) : (
                <div className="px-1 text-xs wallet-muted">
                  Enter an amount to load a live Cauldron quote.
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-4 pb-3">
              <div className="wallet-card p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-xs uppercase tracking-[0.18em] wallet-muted opacity-70">
                      Create / Manage Pools
                    </div>
                    <h2 className="mt-1 text-xl font-semibold wallet-text-strong">
                      {visibleWalletPoolPositions.length > 0
                        ? 'Detected Positions'
                        : 'Market'}
                    </h2>
                  </div>
                  <button
                    type="button"
                    className="wallet-btn-primary px-4 py-2 text-sm"
                    onClick={() => void handleCreatePool()}
                    disabled={
                      submitting ||
                      !canCreatePool
                    }
                  >
                    {submitting ? 'Working...' : 'Create Pool'}
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
                      Pool BCH
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
                            setMessage(
                              'Pool BCH amount was adjusted to stay within your spendable balance.'
                            );
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
                      {poolBchBalanceLabel} (fee buffer reserved)
                    </div>
                  </label>
                  <label className="block">
                    <span className="mb-2 block text-xs font-semibold uppercase tracking-[0.2em] wallet-muted">
                      Pool {effectiveSymbol}
                    </span>
                    <div className="relative">
                      <input
                        value={poolCreateTokenAmount}
                        onChange={(event) => {
                          const nextAmount = sanitizeDecimalInput(
                            event.target.value,
                            effectiveDecimals,
                            spendableTokenBalanceAtomic
                          );
                          if (nextAmount !== event.target.value) {
                            setMessage(
                              `Pool ${effectiveSymbol} amount was adjusted to stay within your token balance.`
                            );
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
                        disabled={submitting || spendableTokenBalanceAtomic <= 0n}
                      >
                        Max
                      </button>
                    </div>
                    <div className="mt-2 text-xs wallet-muted">
                      {poolTokenBalanceLabel}
                    </div>
                  </label>
                </div>
                <div className="mt-2 px-1 text-xs wallet-muted">
                  {!parsedPoolCreateBchAmount || parsedPoolCreateBchAmount <= 0n
                    ? 'Enter a BCH reserve amount to enable Create Pool.'
                    : !parsedPoolCreateTokenAmount ||
                        parsedPoolCreateTokenAmount <= 0n
                      ? `Enter a ${effectiveSymbol} reserve amount to enable Create Pool.`
                      : parsedPoolCreateBchAmount > poolBchMaxInputSats
                        ? 'Pool BCH amount exceeds your spendable BCH balance after the fee buffer.'
                        : parsedPoolCreateTokenAmount > spendableTokenBalanceAtomic
                          ? `Pool ${effectiveSymbol} amount exceeds your available token balance.`
                      : 'Create Pool is ready. Review and sign to publish a new owned pool.'}
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
                    Use Market Ratio
                  </button>
                </div>
              </div>

              <div className="wallet-card p-4">
                {visibleWalletPoolPositions.length > 0 ? (
                  <div className="space-y-3">
                    <div className="mb-2 text-xs uppercase tracking-[0.18em] wallet-muted opacity-70">
                      Tap a pool to view LP stats
                    </div>
                    <div
                      className="space-y-3 overflow-y-auto pr-1"
                      style={{
                        maxHeight:
                          visibleWalletPoolPositions.length > 1
                            ? '16rem'
                            : 'none',
                      }}
                    >
                      {visibleWalletPoolPositions.map((position) => {
                        const poolToken =
                          tokens.find(
                            (token) =>
                              token.tokenId ===
                              position.pool.output.tokenCategory
                          ) ?? null;
                        const poolTokenSymbol =
                          poolToken?.symbol ??
                          shortTokenId(position.pool.output.tokenCategory);
                        const poolTokenName =
                          poolToken?.name ??
                          `Token ${shortTokenId(position.pool.output.tokenCategory)}`;
                        const poolTokenDecimals = poolToken?.decimals ?? 0;
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
                              setSelectedTokenId(
                                position.pool.output.tokenCategory
                              );
                            }}
                            className="w-full rounded-2xl border px-4 py-4 text-left transition"
                            style={
                              selectedWalletPoolPosition &&
                              getPoolSelectionId(selectedWalletPoolPosition.pool) ===
                                getPoolSelectionId(position.pool)
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
                                <div className="text-base font-semibold wallet-text-strong">
                                  {poolTokenName}
                                </div>
                                <div className="mt-1 text-sm wallet-muted">
                                  Token ID:{' '}
                                  {shortTokenId(
                                    position.pool.output.tokenCategory
                                  )}
                                </div>
                              </div>
                              <div className="wallet-surface-strong rounded-full px-3 py-1 text-xs font-semibold wallet-text-strong">
                                {poolTokenSymbol}
                              </div>
                            </div>

                            <div className="mt-4 flex items-center justify-between gap-3 text-sm">
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
                  <p className="text-sm wallet-muted">
                    No active pools owned by this wallet were detected yet.
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {reviewOpen && quote ? (
        <div className="absolute inset-0 z-30 flex items-end bg-black/50 px-4 pb-4 pt-10">
          <div className="wallet-card flex max-h-[85vh] w-full flex-col rounded-[28px] p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-xs uppercase tracking-[0.18em] wallet-muted opacity-70">
                  Transaction Summary
                </div>
                <h2 className="mt-1 text-xl font-semibold wallet-text-strong">
                  Review Cauldron Swap
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setReviewOpen(false)}
                className="wallet-btn-secondary px-4 py-2"
                disabled={submitting}
              >
                Close
              </button>
            </div>

            <div className="mt-4 min-h-0 flex-1 space-y-3 overflow-y-auto pr-1 text-sm">
              <div className="flex items-center justify-between gap-3">
                <span className="wallet-muted">You pay</span>
                <span className="font-medium wallet-text-strong">
                  {spendSummary}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="wallet-muted">You receive</span>
                <span className="font-medium wallet-text-strong">
                  {receiveSummary}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
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
              <div className="flex items-center justify-between gap-3">
                <span className="wallet-muted">Liquidity provider fee</span>
                <span className="font-medium wallet-text-strong">
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
                <span className="wallet-muted">Estimated network fee</span>
                <span className="font-medium wallet-text-strong">
                  {formatCompactBchAmount(quote.estimatedFeeSatoshis)}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="wallet-muted">Pools used</span>
                <span className="font-medium wallet-text-strong">
                  {quote.trades.length}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="wallet-muted">Wallet inputs</span>
                <span className="font-medium wallet-text-strong">
                  {quote.built.walletInputs.length}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="wallet-muted">Fee ratio</span>
                <span className="font-medium wallet-text-strong">
                  {(Number(feeRatioBps) / 100).toFixed(2)}%
                </span>
              </div>
              <div className="wallet-section rounded-2xl px-4 py-3 text-xs leading-5 wallet-muted">
                OPTN will re-check the live Cauldron pools before signing and
                will stop if the refreshed quote falls below your slippage
                protection.
              </div>

              {quote.warnings.length > 0 ? (
                <div className="rounded-2xl border border-[var(--wallet-warning-border)] bg-[var(--wallet-warning-bg)] px-4 py-3">
                  <div className="text-xs font-semibold uppercase tracking-[0.18em] wallet-text-strong">
                    Review Warnings
                  </div>
                  <div className="mt-2 space-y-2 text-sm wallet-text-strong">
                    {quote.warnings.map((warning) => (
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
                  Wallet Inputs
                </div>
                <div className="mt-2 space-y-2">
                  {quote.built.walletInputs.map((input) => (
                    <div
                      key={`${input.utxo.tx_hash}:${input.utxo.tx_pos}`}
                      className="flex items-center justify-between gap-3 text-sm"
                    >
                      <span className="wallet-muted">
                        {shortAddress(input.utxo.address)}#{input.utxo.tx_pos}
                      </span>
                      <span className="wallet-text-strong">
                        {input.utxo.token
                          ? formatTokenDisplayAmount(
                              parseSatoshis(input.utxo.token.amount),
                              input.utxo.token.category === selectedTokenId
                                ? effectiveDecimals
                                : 0,
                              input.utxo.token.category === selectedTokenId
                                ? effectiveSymbol
                                : shortTokenId(input.utxo.token.category)
                            )
                          : formatCompactBchAmount(
                              parseSatoshis(
                                input.utxo.amount ?? input.utxo.value
                              )
                            )}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-2xl border border-[var(--wallet-border)] px-4 py-3">
                <div className="text-xs uppercase tracking-[0.18em] wallet-muted opacity-70">
                  Settlement Outputs
                </div>
                <div className="mt-2 space-y-2">
                  {quote.built.settlementOutputs.map((output, index) => (
                    <div
                      key={`settlement-${index}`}
                      className="flex items-center justify-between gap-3 text-sm"
                    >
                      <span className="wallet-muted">
                        {index === 0
                          ? 'Primary receive'
                          : output.token
                            ? 'Token change'
                            : 'BCH change'}
                      </span>
                      <span className="text-right wallet-text-strong">
                        {output.token
                          ? formatTokenDisplayAmount(
                              output.token.amount,
                              effectiveDecimals,
                              output.token.amount === quote.totalDemand
                                ? effectiveSymbol
                                : effectiveSymbol
                            )
                          : formatCompactBchAmount(output.valueSatoshis)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-2xl border border-[var(--wallet-border)] px-4 py-3">
                <div className="text-xs uppercase tracking-[0.18em] wallet-muted opacity-70">
                  Route
                </div>
                <div className="mt-2 flex items-center justify-between gap-3 text-sm">
                  <span className="wallet-muted">Pools in route</span>
                  <button
                    type="button"
                    onClick={() => setReviewRouteExpanded((current) => !current)}
                    className="wallet-btn-secondary px-3 py-1.5 text-xs"
                  >
                    {reviewRouteExpanded
                      ? 'Hide route'
                      : `Show route (${previewedRouteRows.length})`}
                  </button>
                </div>
                {!reviewRouteExpanded ? (
                  <div className="mt-3 rounded-2xl border border-[var(--wallet-border)] px-3 py-3 text-xs">
                    <div className="flex items-center justify-between gap-3">
                      <span className="wallet-muted">Primary hops shown</span>
                      <span className="wallet-text-strong">
                        {Math.min(previewedRouteRows.length, 2)} / {previewedRouteRows.length}
                      </span>
                    </div>
                    {hiddenRouteCount > 0 ? (
                      <div className="mt-2 flex items-center justify-between gap-3">
                        <span className="wallet-muted">Remaining route</span>
                        <span className="text-right wallet-text-strong">
                          {hiddenRouteCount} pools combine to{' '}
                          {direction === 'bch_to_token'
                            ? formatTokenDisplayAmount(
                                hiddenRouteDemand,
                                effectiveDecimals,
                                effectiveSymbol
                              )
                            : formatCompactBchAmount(hiddenRouteDemand)}
                        </span>
                      </div>
                    ) : null}
                  </div>
                ) : null}
                {reviewRouteExpanded ? (
                  <div className="mt-3 max-h-44 space-y-2 overflow-y-auto pr-1">
                    {previewedRouteRows.map((trade) => (
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
                  </div>
                ) : (
                  <div className="mt-3 space-y-2">
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
                )}
              </div>
            </div>

            <div className="mt-4 flex gap-3">
              <button
                type="button"
                onClick={() => setReviewOpen(false)}
                className="wallet-btn-secondary flex-1"
                disabled={submitting}
              >
                Back
              </button>
              <button
                type="button"
                onClick={() => {
                  void handleSwap();
                  setReviewOpen(false);
                }}
                className="wallet-btn-primary flex-1"
                disabled={
                  submitting ||
                  (quote.warnings.length > 0 && !reviewWarningsAccepted)
                }
              >
                {submitting ? 'Signing...' : 'Confirm And Broadcast'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {poolReview ? (
        <div className="absolute inset-0 z-40 flex items-end bg-black/50 px-4 pb-4 pt-10">
          <div className="wallet-card w-full rounded-[28px] p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-xs uppercase tracking-[0.18em] wallet-muted opacity-70">
                  Transaction Summary
                </div>
                <h2 className="mt-1 text-xl font-semibold wallet-text-strong">
                  {poolReview.kind === 'create'
                    ? 'Review Pool Creation'
                    : 'Review Pool Withdrawal'}
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setPoolReview(null)}
                className="wallet-btn-secondary px-4 py-2"
                disabled={submitting}
              >
                Close
              </button>
            </div>

            <div className="mt-4 space-y-3 text-sm">
              {poolReview.kind === 'create' ? (
                <>
                  <div className="flex items-center justify-between gap-3">
                    <span className="wallet-muted">Pool BCH</span>
                    <span className="font-medium wallet-text-strong">
                      {formatCompactBchAmount(poolReview.bchAmount)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="wallet-muted">Pool token</span>
                    <span className="font-medium wallet-text-strong">
                      {formatTokenDisplayAmount(
                        poolReview.tokenAmount,
                        effectiveDecimals,
                        effectiveSymbol
                      )}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="wallet-muted">Wallet inputs</span>
                    <span className="font-medium wallet-text-strong">
                      {poolReview.built.walletInputs.length}
                    </span>
                  </div>
                </>
              ) : (
                <>
                  <div className="flex items-center justify-between gap-3">
                    <span className="wallet-muted">Withdraw BCH</span>
                    <span className="font-medium wallet-text-strong">
                      {formatCompactBchAmount(poolReview.pool.output.amountSatoshis)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="wallet-muted">Withdraw token</span>
                    <span className="font-medium wallet-text-strong">
                      {formatTokenDisplayAmount(
                        poolReview.pool.output.tokenAmount,
                        selectedPoolDecimals,
                        selectedPoolSymbol
                      )}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="wallet-muted">Owner input</span>
                    <span className="font-medium wallet-text-strong">
                      {formatCompactBchAmount(
                        parseSatoshis(
                          poolReview.built.ownerInput.utxo.amount ??
                            poolReview.built.ownerInput.utxo.value
                        )
                      )}
                    </span>
                  </div>
                </>
              )}

              <div className="flex items-center justify-between gap-3">
                <span className="wallet-muted">Estimated network fee</span>
                <span className="font-medium wallet-text-strong">
                  {formatCompactBchAmount(poolReview.built.estimatedFeeSatoshis)}
                </span>
              </div>

              <div className="wallet-section rounded-2xl px-4 py-3 text-xs leading-5 wallet-muted">
                {poolReview.kind === 'create'
                  ? 'OPTN will create a new Cauldron-owned pool UTXO for this token pair amount using your selected funding inputs.'
                  : 'OPTN will withdraw the selected owned pool into your wallet using the pool owner key and a BCH funding input for settlement.'}
              </div>
            </div>

            <div className="mt-4 flex gap-3">
              <button
                type="button"
                onClick={() => setPoolReview(null)}
                className="wallet-btn-secondary flex-1"
                disabled={submitting}
              >
                Back
              </button>
              <button
                type="button"
                onClick={() => void handleConfirmPoolReview()}
                className="wallet-btn-primary flex-1"
                disabled={submitting}
              >
                {submitting ? 'Signing...' : 'Confirm And Broadcast'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {selectedWalletPoolPosition ? (
        <div className="absolute inset-0 z-30 flex items-end bg-black/50 px-4 pb-4 pt-4">
          <div className="wallet-card flex max-h-full w-full flex-col rounded-[28px] p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-xs uppercase tracking-[0.18em] wallet-muted opacity-70">
                  LP Position
                </div>
                <h2 className="mt-1 text-xl font-semibold wallet-text-strong">
                  {selectedPoolName}
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setSelectedWalletPoolId(null)}
                className="wallet-btn-secondary px-4 py-2"
                disabled={submitting}
              >
                Close
              </button>
            </div>

            <div className="mt-4 flex gap-3">
              <button
                type="button"
                onClick={() => void handleWithdrawPool()}
                className="wallet-btn-primary flex-1"
                disabled={submitting}
              >
                {submitting ? 'Signing...' : 'Withdraw Pool'}
              </button>
            </div>

            <div className="mt-4 min-h-0 flex-1 overflow-y-auto pr-1">
              <div className="space-y-3 text-sm">
                <div className="rounded-2xl border border-[var(--wallet-border)] px-4 py-3">
                  <div className="text-xs uppercase tracking-[0.18em] wallet-muted opacity-70">
                    Current Position
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
                      History Window
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
                  Recent Activity
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
                              <span>{shortTokenId(entry.txid)}</span>
                            </div>
                            <div className="mt-2 flex items-center justify-between gap-3 text-sm">
                              <span className="wallet-muted">BCH reserve</span>
                              <span className="font-medium text-white">
                                {formatCompactBchAmount(
                                  parseSatoshis(entry.sats)
                                )}
                              </span>
                            </div>
                            <div className="mt-1 flex items-center justify-between gap-3 text-sm">
                              <span className="wallet-muted">
                                {selectedPoolSymbol} reserve
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
                                  BCH delta{' '}
                                  <span className="font-medium text-white">
                                    {formatSignedBchAmount(bchDelta)}
                                  </span>
                                </span>
                                <span className="wallet-muted">
                                  {selectedPoolSymbol} delta{' '}
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
          </div>
        </div>
      ) : null}

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
                            ? formatCompactBchAmount(BigInt(Math.trunc(token.tvlSats)))
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
