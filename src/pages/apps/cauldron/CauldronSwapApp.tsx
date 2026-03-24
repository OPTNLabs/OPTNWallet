import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSelector } from 'react-redux';

import type { AddonSDK } from '../../../services/AddonsSDK';
import type { AddonAppDefinition, AddonManifest } from '../../../types/addons';
import { selectCurrentNetwork } from '../../../redux/selectors/networkSelectors';
import type { RootState } from '../../../redux/store';
import useSharedTokenMetadata from '../../../hooks/useSharedTokenMetadata';
import { parseSatoshis } from '../../../utils/binary';
import {
  CAULDRON_NATIVE_BCH,
  CauldronApiClient,
  buildCauldronTradeRequest,
  detectCauldronWalletPoolPositions,
  fetchNormalizedCauldronPools,
  fetchNormalizedCauldronUserPools,
  getCauldronSubscriptionService,
  normalizeCauldronPoolRow,
  normalizeCauldronTokenRow,
  planAggregatedTradeForTargetSupply,
  resolveCauldronFundingInputs,
  signAndBroadcastCauldronTradeRequest,
  type BuiltCauldronTradeRequest,
  type CauldronAggregatedApyResponse,
  type CauldronPool,
  type CauldronPoolHistoryResponse,
  type CauldronPoolTrade,
  type CauldronWalletPoolPosition,
  type NormalizedCauldronToken,
} from '../../../services/cauldron';
import type { UTXO } from '../../../types/types';

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

const SAFETY_MAX_ROUTE_POOLS = 4;
const SAFETY_MAX_WALLET_INPUTS = 4;
const SAFETY_HIGH_SLIPPAGE_BPS = 300n;
const SAFETY_HIGH_FEE_BPS = 100n;

function shortTokenId(tokenId: string): string {
  if (!tokenId) return '';
  return tokenId.length <= 12
    ? tokenId
    : `${tokenId.slice(0, 4)}...${tokenId.slice(-3)}`;
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

function findFirstNumericExtensionValue(
  value: unknown,
  path: string[] = []
): string | null {
  if (path.length > 5 || value == null) return null;

  if (typeof value === 'string') {
    const trimmed = value.trim();
    return /^\d+(\.\d+)?$/.test(trimmed) ? trimmed : null;
  }
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return String(value);
  }
  if (typeof value !== 'object') return null;

  const entries = Object.entries(value as Record<string, unknown>);
  const preferredKeys = [
    'max_supply',
    'maxSupply',
    'supply_cap',
    'supplyCap',
    'cap',
    'total_supply',
    'totalSupply',
  ];

  for (const key of preferredKeys) {
    const match = entries.find(([entryKey]) => entryKey === key);
    if (!match) continue;
    const nested = findFirstNumericExtensionValue(match[1], [...path, match[0]]);
    if (nested) return nested;
  }

  for (const [, nestedValue] of entries) {
    const nested = findFirstNumericExtensionValue(nestedValue, [...path, '']);
    if (nested) return nested;
  }

  return null;
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

function selectFundingUtxosByToken(
  utxos: UTXO[],
  tokenCategory: string,
  requiredTokenAmount: bigint
): UTXO[] {
  const tokenUtxos = [...utxos]
    .filter(
      (utxo) => utxo.token?.category === tokenCategory && !utxo.token?.nft
    )
    .sort((a, b) =>
      Number(BigInt(b.token?.amount ?? 0) - BigInt(a.token?.amount ?? 0))
    );

  const selected: UTXO[] = [];
  let total = 0n;
  for (const utxo of tokenUtxos) {
    selected.push(utxo);
    total += BigInt(utxo.token?.amount ?? 0);
    if (total >= requiredTokenAmount) break;
  }
  return total >= requiredTokenAmount ? selected : [];
}

function selectLargestBchUtxos(utxos: UTXO[]): UTXO[] {
  return [...utxos]
    .filter((utxo) => !utxo.token)
    .sort((a, b) =>
      Number((b.amount ?? b.value ?? 0) - (a.amount ?? a.value ?? 0))
    );
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
  if (tokenFunding.length === 0) {
    throw new Error('Not enough token UTXOs are available for this swap.');
  }

  for (let extraBch = 0; extraBch <= sortedBchUtxos.length; extraBch += 1) {
    const selected = [...tokenFunding, ...sortedBchUtxos.slice(0, extraBch)];
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
  const [walletPoolPositions, setWalletPoolPositions] = useState<
    CauldronWalletPoolPosition[]
  >([]);
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
  const [, setApiStatus] = useState<{
    tokensLoaded: number;
    poolsLoaded: number;
    tokenSource: 'api' | 'pools' | 'mixed';
    liveUpdatesEnabled: boolean;
    liveUpdatedAt: number | null;
  } | null>(null);

  const feeRate = 1n;
  const quoteActionsDisabled = true;
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

        if (cancelled) return;

        const poolMap = new Map<string, CauldronPool>();
        [...userPools, ...nftCandidatePools.flat()].forEach((pool) => {
          poolMap.set(
            pool.poolId ?? `${pool.txHash}:${pool.outputIndex}`,
            pool
          );
        });

        setWalletPoolPositions(
          detectCauldronWalletPoolPositions(
            [...poolMap.values()],
            walletUtxos.tokenUtxos
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
  }, [currentNetwork, sdk]);

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
      (livePools.length > 0 ? livePools : pools).filter(
        (pool) => pool.output.tokenCategory === selectedTokenId
      ),
    [livePools, pools, selectedTokenId]
  );
  const visibleWalletPoolPositions = useMemo(() => {
    if (!selectedTokenId) return walletPoolPositions;
    const filtered = walletPoolPositions.filter(
      (position) => position.pool.output.tokenCategory === selectedTokenId
    );
    return filtered.length > 0 ? filtered : walletPoolPositions;
  }, [selectedTokenId, walletPoolPositions]);
  const selectedWalletPoolPosition = useMemo(
    () =>
      visibleWalletPoolPositions.find(
        (position) => position.pool.poolId === selectedWalletPoolId
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
  const selectedTokenMaxSupplyAtomic = useMemo(() => {
    const maxSupplyValue = findFirstNumericExtensionValue(
      selectedMetadata?.snapshot?.extensions
    );
    if (!maxSupplyValue) return null;
    return parseDecimalToAtomic(maxSupplyValue, effectiveDecimals);
  }, [effectiveDecimals, selectedMetadata?.snapshot?.extensions]);
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
    if (
      selectedWalletPoolId &&
      !visibleWalletPoolPositions.some(
        (position) => position.pool.poolId === selectedWalletPoolId
      )
    ) {
      setSelectedWalletPoolId(null);
      setSelectedWalletPoolHistory(null);
    }
  }, [selectedWalletPoolId, visibleWalletPoolPositions]);

  useEffect(() => {
    let cancelled = false;

    if (!selectedWalletPoolId) {
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
        const history = await client.getPoolHistory(selectedWalletPoolId);
        const apyResponse = await client
          .getAggregatedApy({
            poolId: selectedWalletPoolId,
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
  }, [currentNetwork, selectedWalletPoolId]);

  const parsedAmount = useMemo(
    () =>
      direction === 'bch_to_token'
        ? parseBchInputToSats(amount)
        : parseDecimalToAtomic(amount, effectiveDecimals),
    [amount, direction, effectiveDecimals]
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
      return {
        plan:
          planAggregatedTradeForTargetSupply(
            tokenPools,
            direction === 'bch_to_token'
              ? CAULDRON_NATIVE_BCH
              : selectedTokenId,
            direction === 'bch_to_token'
              ? selectedTokenId
              : CAULDRON_NATIVE_BCH,
            parsedAmount
          ) ?? null,
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
  const canSwap = Boolean(selectedTokenId && parsedAmount && parsedAmount > 0n);
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
      if (tokenPools.length === 0) {
        throw new Error('No active Cauldron pools were found for this token.');
      }

      const planned = planAggregatedTradeForTargetSupply(
        tokenPools,
        direction === 'bch_to_token' ? CAULDRON_NATIVE_BCH : selectedTokenId,
        direction === 'bch_to_token' ? selectedTokenId : CAULDRON_NATIVE_BCH,
        parsedAmount
      );
      if (!planned) {
        throw new Error(
          'No Cauldron quote is currently available for that amount.'
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
      const built = await buildTradeWithFunding({
        walletId: walletContext.walletId,
        allUtxos: walletUtxos.allUtxos,
        trades: planned.trades,
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
      if (planned.trades.length > SAFETY_MAX_ROUTE_POOLS) {
        warnings.push(
          `This route uses ${planned.trades.length} pools, which is more complex than a typical swap.`
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

      setQuote({
        trades: planned.trades,
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

      const refreshedPools = await fetchNormalizedCauldronPools(
        currentNetwork,
        undefined,
        selectedTokenId
      );
      const relevantPools = refreshedPools.filter(
        (pool) => pool.output.tokenCategory === selectedTokenId
      );
      const replanned = planAggregatedTradeForTargetSupply(
        relevantPools,
        direction === 'bch_to_token' ? CAULDRON_NATIVE_BCH : selectedTokenId,
        direction === 'bch_to_token' ? selectedTokenId : CAULDRON_NATIVE_BCH,
        parsedAmount
      );
      if (!replanned) {
        throw new Error('Cauldron quote expired. Try again.');
      }
      if (replanned.summary.demand < quote.minReceive) {
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
      const built = await buildTradeWithFunding({
        walletId: walletContext.walletId,
        allUtxos: walletUtxos.allUtxos,
        trades: replanned.trades,
        direction,
        selectedTokenId,
        recipientAddress: primaryAddress,
        changeAddress: addresses[0].address,
        tokenChangeAddress: addresses[0].tokenAddress || addresses[0].address,
        feeRate,
        userPrompt:
          direction === 'bch_to_token'
            ? `Cauldron swap ${formatBchAmount(replanned.summary.supply)} BCH -> ${effectiveSymbol}`
            : `Cauldron swap ${formatTokenAmount(replanned.summary.supply, effectiveDecimals)} ${effectiveSymbol} -> BCH`,
      });

      const result = await signAndBroadcastCauldronTradeRequest(
        walletContext.walletId,
        built,
        {
          sourceLabel: 'Cauldron Swap',
          recipientSummary: effectiveName || selectedTokenId,
          amountSummary:
            direction === 'bch_to_token'
              ? `${formatBchAmount(replanned.summary.supply)} BCH`
              : `${formatTokenAmount(replanned.summary.supply, effectiveDecimals)} ${effectiveSymbol}`,
          userPrompt: built.signRequest.transaction.userPrompt ?? null,
        }
      );
      if (result.errorMessage) {
        throw new Error(result.errorMessage);
      }

      setQuote({
        trades: replanned.trades,
        totalSupply: replanned.summary.supply,
        totalDemand: replanned.summary.demand,
        estimatedFeeSatoshis: built.estimatedFeeSatoshis,
        minReceive: quote.minReceive,
        built,
        warnings: quote.warnings,
      });
      setMessage(`Swap submitted: ${result.txid}`);
    } catch (error) {
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

      <div className="flex min-h-0 flex-1 flex-col pt-3">
        {message ? (
          <div className="wallet-warning-panel flex-none rounded-2xl px-4 py-3 text-sm">
            {message}
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
                      <span className="text-xs wallet-muted opacity-80">
                        {payBalanceCaption}
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
                              direction === 'token_to_bch'
                                ? selectedTokenMaxSupplyAtomic
                                : null
                            );
                            if (
                              direction === 'token_to_bch' &&
                              selectedTokenMaxSupplyAtomic != null &&
                              nextAmount !== event.target.value
                            ) {
                              setMessage(
                                'Amount was adjusted to match this token\'s allowed precision or published max supply.'
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
                      Liquidity Pools
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
                    disabled
                  >
                    Add Position
                  </button>
                </div>

                <label className="mt-4 block">
                  <span className="mb-2 block text-xs font-semibold uppercase tracking-[0.2em] wallet-muted">
                    Market Filter
                  </span>
                  {renderTokenPickerTrigger()}
                </label>
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
                                position.pool.poolId ?? null
                              );
                              setSelectedTokenId(
                                position.pool.output.tokenCategory
                              );
                            }}
                            className="w-full rounded-2xl border px-4 py-4 text-left transition"
                            style={
                              selectedWalletPoolPosition?.pool.poolId ===
                              position.pool.poolId
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
          <div className="wallet-card w-full rounded-[28px] p-4">
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

            <div className="mt-4 space-y-3 text-sm">
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
                <div className="mt-2 space-y-2">
                  {quote.trades.map((trade) => (
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
              >
                Close
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
