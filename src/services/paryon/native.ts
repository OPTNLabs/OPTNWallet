import type { AddonSDK } from '../AddonsSDK';
import type { UTXO } from '../../types/types';
import {
  buildDefaultSystemHealth,
  buildParyonFlowPlans,
  deriveParyonThreadHealth,
  indexParyonPositions,
} from './domain';
import type {
  ParyonActionKind,
  ParyonContractBundleName,
  ParyonFlowPlanGroup,
  ParyonNativeView,
  ParyonDeploymentConfig,
  ParyonPositionIndex,
  ParyonSystemHealth,
  ParyonThreadHealth,
  ParyonWorkspaceSnapshot,
} from './types';

type ChainOutputRow = {
  transaction_hash?: string;
  output_index?: number;
  value_satoshis?: number | string | null;
  token_category?: string | null;
  fungible_token_amount?: string | number | bigint | null;
  nonfungible_token_capability?: 'none' | 'mutable' | 'minting' | null;
  nonfungible_token_commitment?: string | null;
  locking_bytecode?: string | null;
};

function utxoToChainOutputRow(utxo: UTXO): ChainOutputRow {
  return {
    transaction_hash: utxo.tx_hash,
    output_index: utxo.tx_pos,
    value_satoshis: utxo.value ?? utxo.amount ?? 0,
    token_category: utxo.token?.category ?? null,
    fungible_token_amount: utxo.token?.amount ?? null,
    nonfungible_token_capability: utxo.token?.nft?.capability ?? null,
    nonfungible_token_commitment: utxo.token?.nft?.commitment ?? null,
  };
}

export type ParyonWalletBalances = {
  bchSats: bigint;
  pusdAtomic: bigint;
  spendableUtxoCount: number;
  tokenUtxoCount: number;
};

export type ParyonLiveContractState = {
  name: ParyonContractBundleName;
  address: string;
  tokenId: string;
  resolved: boolean;
  utxoCount: number;
  totalValueSats: bigint;
  latestCommitment: string | null;
  latestTokenAmount: bigint | null;
  latestCapability: 'none' | 'mutable' | 'minting' | null;
  preferredOutpoint: string | null;
  threadCount: number;
  freshness: 'fresh' | 'degraded' | 'stale' | 'missing';
  warnings: string[];
};

export type ParyonLiveMarketState = {
  oraclePriceCentsPerBch: bigint | null;
  currentPeriod: number | null;
  currentEpoch: number | null;
  chainHeight: number | null;
  expectedPeriod: number | null;
  periodDeltaPeriods: number | null;
  writeEnabled: boolean;
  verifiedMainnetV1: boolean;
};

type ParyonLiveThreadContractName =
  | 'PriceContract'
  | 'Borrowing'
  | 'StabilityPool'
  | 'Redeemer'
  | 'LoanKeyFactory';

export type ParyonPositionSummary = {
  loans: number;
  stakes: number;
  redemptions: number;
};

export type ParyonNativeSnapshot = {
  balances: ParyonWalletBalances;
  market: ParyonLiveMarketState;
  liveContracts: {
    PriceContract: ParyonLiveContractState;
    Borrowing: ParyonLiveContractState;
    StabilityPool: ParyonLiveContractState;
    Redeemer: ParyonLiveContractState;
    LoanKeyFactory: ParyonLiveContractState;
  };
  positions: ParyonPositionSummary;
  positionIndex: ParyonPositionIndex;
  threadHealth: ParyonThreadHealth[];
  systemHealth: ParyonSystemHealth;
  flowPlans: ParyonFlowPlanGroup;
  walletUtxos: UTXO[];
  tokenUtxos: UTXO[];
  warnings: string[];
  loadedAt: number;
};

export type ParyonActionPreview = {
  action: ParyonActionKind;
  title: string;
  amountAtomic: bigint | null;
  amountLabel: string;
  primaryMetricLabel: string;
  primaryMetricValue: string;
  secondaryMetricLabel: string;
  secondaryMetricValue: string;
  details: string[];
  warnings: string[];
  canProceed: boolean;
  blockedReason: string | null;
};

export type ParyonTransactionPlan = ParyonActionPreview;

export const PARYON_NATIVE_VIEWS: Array<{
  view: ParyonNativeView;
  label: string;
  description: string;
}> = [
  {
    view: 'dashboard',
    label: 'Dashboard',
    description: 'Readiness, balances, and live positions',
  },
  {
    view: 'borrow',
    label: 'Loan',
    description: 'Open or manage a live PUSD loan',
  },
  {
    view: 'stake',
    label: 'Stability Pool',
    description: 'Stake, withdraw, or claim pool rewards',
  },
  {
    view: 'redeem',
    label: 'Redemption',
    description: 'Redeem PUSD back to BCH',
  },
  {
    view: 'history',
    label: 'History',
    description: 'Wallet-linked position timeline',
  },
  {
    view: 'stats',
    label: 'Operator',
    description: 'Thread health and system routing',
  },
  {
    view: 'faq',
    label: 'FAQ',
    description: 'How the stablecoin works',
  },
  {
    view: 'docs',
    label: 'Docs',
    description: 'Contract model and launch notes',
  },
];

function normalizeHex(value: unknown): string {
  return String(value ?? '')
    .trim()
    .replace(/^\\x/i, '')
    .replace(/^0x/i, '')
    .toLowerCase();
}

function toBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return BigInt(Math.trunc(value));
  }
  if (typeof value === 'string') {
    try {
      return BigInt(value.trim() || '0');
    } catch {
      return 0n;
    }
  }
  return 0n;
}

function formatAtomicAmount(
  value: bigint,
  decimals: number,
  options?: { trimTrailingZeros?: boolean }
): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const divisor = 10n ** BigInt(decimals);
  const whole = absolute / divisor;
  const fraction = decimals > 0 ? absolute % divisor : 0n;

  if (decimals === 0) {
    return `${negative ? '-' : ''}${whole.toString()}`;
  }

  const fractionText = fraction.toString().padStart(decimals, '0');
  const trimmed =
    options?.trimTrailingZeros === false
      ? fractionText
      : fractionText.replace(/0+$/, '');
  const rendered = trimmed ? `${whole.toString()}.${trimmed}` : whole.toString();
  return `${negative ? '-' : ''}${rendered}`;
}

export function formatBchSats(value: bigint): string {
  return `${formatAtomicAmount(value, 8)} BCH`;
}

export function formatPusdAtomic(value: bigint): string {
  return `${formatAtomicAmount(value, 2, { trimTrailingZeros: false })} PUSD`;
}

export function formatUsdCents(value: bigint): string {
  return `$${formatAtomicAmount(value, 2, { trimTrailingZeros: false })}`;
}

export function shortHex(value: string, head = 10, tail = 6): string {
  if (!value) return '(unset)';
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

function parseCommitmentAmount(hex: string, offsetFromEndBytes: number): bigint | null {
  const normalized = normalizeHex(hex);
  const width = offsetFromEndBytes * 2;
  if (normalized.length < width) return null;
  const slice = normalized.slice(normalized.length - width);
  try {
    return BigInt(`0x${slice}`);
  } catch {
    return null;
  }
}

export function parseOraclePriceCentsPerBch(commitment: string | null): bigint | null {
  const normalized = normalizeHex(commitment);
  if (normalized.length < 8) return null;
  return parseCommitmentAmount(normalized, 4);
}

export function parseStabilityPoolState(commitment: string | null): {
  currentPeriod: number | null;
  totalStakedEpoch: bigint | null;
  remainingStakedEpoch: bigint | null;
} {
  const normalized = normalizeHex(commitment);
  if (normalized.length < 32) {
    return {
      currentPeriod: null,
      totalStakedEpoch: null,
      remainingStakedEpoch: null,
    };
  }

  const currentPeriod = parseCommitmentAmount(normalized.slice(0, 8), 4);
  const totalStakedEpoch = parseCommitmentAmount(normalized.slice(8, 20), 6);
  const remainingStakedEpoch = parseCommitmentAmount(
    normalized.slice(20, 32),
    6
  );

  return {
    currentPeriod:
      currentPeriod != null && currentPeriod <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(currentPeriod)
        : null,
    totalStakedEpoch,
    remainingStakedEpoch,
  };
}

function parseLatestBlockHeight(latest: unknown): number | null {
  if (!latest || typeof latest !== 'object') return null;
  const height = (latest as { height?: unknown }).height;
  if (typeof height === 'number' && Number.isFinite(height)) return height;
  if (typeof height === 'string' && height.trim()) {
    const parsed = Number(height);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

async function safeGetLatestBlock(sdk: AddonSDK): Promise<number | null> {
  try {
    return parseLatestBlockHeight(await sdk.chain.getLatestBlock());
  } catch {
    return null;
  }
}

function deriveExpectedPeriod(
  chainHeight: number | null,
  config: ParyonDeploymentConfig
): number | null {
  if (chainHeight == null) return null;
  const relativeHeight = chainHeight - config.startBlockHeight;
  if (relativeHeight < 0) return null;
  return Math.floor(relativeHeight / config.periodLengthBlocks);
}

export function paryonNativeViewReducer(
  state: ParyonNativeView,
  next:
    | { type: 'navigate'; view: ParyonNativeView }
    | { type: 'home' }
    | { type: 'back' }
): ParyonNativeView {
  switch (next.type) {
    case 'navigate':
      return next.view;
    case 'home':
    case 'back':
      return 'dashboard';
    default:
      return state;
  }
}

function tokenIdForContract(
  name: ParyonContractBundleName,
  config: ParyonDeploymentConfig
): string {
  switch (name) {
    case 'StabilityPool':
    case 'StabilityPoolSidecar':
    case 'WithdrawFromPool':
    case 'NewPeriodPool':
    case 'Payout':
      return config.tokenIds.poolTokenId;
    case 'Redeemer':
      return config.tokenIds.redeemerTokenId;
    case 'LoanKeyFactory':
    case 'LoanKeyOriginEnforcer':
    case 'LoanKeyOriginProof':
      return config.tokenIds.loanKeyFactoryTokenId;
    case 'Borrowing':
    case 'PriceContract':
    case 'Collector':
    case 'AddLiquidity':
    case 'LiquidateLoan':
    case 'Loan':
    case 'LoanSidecar':
    case 'Redemption':
    case 'RedemptionSidecar':
    case 'liquidate':
    case 'manage':
    case 'redeem':
    case 'startRedemption':
    case 'swapInRedemption':
    case 'swapOutRedemption':
    case 'payInterest':
    case 'changeInterest':
    default:
      return config.tokenIds.paryonTokenId;
  }
}

async function queryContractState(
  sdk: AddonSDK,
  snapshot: ParyonWorkspaceSnapshot,
  name: ParyonContractBundleName
): Promise<ParyonLiveContractState> {
  const tokenId = tokenIdForContract(name, snapshot.config);
  const contract = snapshot.contractsByName[name];
  const address = contract?.address ?? '(unresolved)';
  if (!contract?.resolved || !address || address === '(unresolved)') {
    return {
      name,
      address,
      tokenId,
      resolved: false,
      utxoCount: 0,
      totalValueSats: 0n,
      latestCommitment: null,
      latestTokenAmount: null,
      latestCapability: null,
      preferredOutpoint: null,
      threadCount: 0,
      freshness: 'missing',
      warnings: ['Thread did not resolve against the live bundle.'],
    };
  }

  const buildState = (rows: ChainOutputRow[], warnings: string[]): ParyonLiveContractState => {
    const preferredRow = rows[0] ?? null;
    const preferredOutpoint =
      preferredRow?.transaction_hash != null && preferredRow.output_index != null
        ? `${String(preferredRow.transaction_hash)}:${preferredRow.output_index}`
        : null;

    const totalValueSats = rows.reduce(
      (sum, row) => sum + toBigInt(row.value_satoshis ?? 0),
      0n
    );
    const latest = preferredRow;

    return {
      name,
      address,
      tokenId,
      resolved: true,
      utxoCount: rows.length,
      totalValueSats,
      latestCommitment: normalizeHex(latest?.nonfungible_token_commitment),
      latestTokenAmount: latest ? toBigInt(latest.fungible_token_amount ?? 0) : null,
      latestCapability: latest?.nonfungible_token_capability ?? null,
      preferredOutpoint,
      threadCount: rows.length,
      freshness: rows.length > 0 ? 'fresh' : 'stale',
      warnings,
    };
  };

  const queryChainGraphRows = async (): Promise<ChainOutputRow[]> => {
    const response = await sdk.chain.queryUnspentByLockingBytecode(
      contract.lockingBytecodeHex,
      tokenId
    );
    return Array.isArray(response?.data?.output)
      ? (response.data.output as ChainOutputRow[])
      : [];
  };

  const queryElectrumRows = async (): Promise<ChainOutputRow[]> => {
    const utxos = await sdk.utxos.listForAddress(address);
    return utxos
      .filter((utxo) => normalizeHex(utxo.token?.category) === normalizeHex(tokenId))
      .map(utxoToChainOutputRow)
      .sort((a, b) => Number(toBigInt(b.value_satoshis ?? 0) - toBigInt(a.value_satoshis ?? 0)));
  };

  const queryElectrumRowsLoose = async (): Promise<ChainOutputRow[]> => {
    const utxos = await sdk.utxos.listForAddress(address);
    return utxos
      .map(utxoToChainOutputRow)
      .sort((a, b) => Number(toBigInt(b.value_satoshis ?? 0) - toBigInt(a.value_satoshis ?? 0)));
  };

  try {
    const rows = await queryChainGraphRows();
    if (rows.length > 0) {
      const warnings =
        rows.length > 1
          ? [
              `Multiple live outputs were discovered for ${name}; routing will prefer ${rows[0]?.transaction_hash ?? 'the first returned output'}.`,
            ]
          : [];
      return buildState(rows, warnings);
    }

    try {
      const fallbackRows = await queryElectrumRows();
      if (fallbackRows.length > 0) {
        const warnings =
          fallbackRows.length > 1
            ? [
                `ChainGraph returned no live outputs for ${name}; Electrum address lookup discovered ${fallbackRows.length} live output(s).`,
              ]
            : ['ChainGraph returned no live outputs; Electrum address lookup succeeded.'];
        return buildState(fallbackRows, warnings);
      }
    } catch {
      // fall through to stale result below
    }

    try {
      const fallbackRows = await queryElectrumRowsLoose();
      if (fallbackRows.length > 0) {
        return buildState(fallbackRows, [
          'ChainGraph returned no live outputs for this thread; Electrum address lookup found contract outputs with a non-matching token category.',
        ]);
      }
    } catch {
      // fall through to stale result below
    }

    return {
      name,
      address,
      tokenId,
      resolved: true,
      utxoCount: 0,
      totalValueSats: 0n,
      latestCommitment: null,
      latestTokenAmount: null,
      latestCapability: null,
      preferredOutpoint: null,
      threadCount: 0,
      freshness: 'stale',
      warnings: ['No live contract outputs were discovered for this thread.'],
    };
  } catch {
    try {
      const fallbackRows = await queryElectrumRows();
      if (fallbackRows.length > 0) {
        return buildState(fallbackRows, [
          'ChainGraph lookup failed; Electrum address lookup discovered live output(s).',
        ]);
      }
    } catch {
      // fall through
    }

    try {
      const fallbackRows = await queryElectrumRowsLoose();
      if (fallbackRows.length > 0) {
        return buildState(fallbackRows, [
          'ChainGraph lookup failed; Electrum address lookup found contract outputs with a non-matching token category.',
        ]);
      }
    } catch {
      // fall through
    }

    return {
      name,
      address,
      tokenId,
      resolved: false,
      utxoCount: 0,
      totalValueSats: 0n,
      latestCommitment: null,
      latestTokenAmount: null,
      latestCapability: null,
      preferredOutpoint: null,
      threadCount: 0,
      freshness: 'missing',
      warnings: ['Thread lookup failed while querying live contract outputs.'],
    };
  }
}

function summarizeBalances(
  allUtxos: UTXO[],
  tokenUtxos: UTXO[],
  paryonTokenId: string
): ParyonWalletBalances {
  const spendable = allUtxos.filter((utxo) => !utxo.contractName);
  const bchSats = spendable.reduce((sum, utxo) => sum + toBigInt(utxo.value ?? utxo.amount ?? 0), 0n);
  const pusdAtomic = spendable.reduce((sum, utxo) => {
    if (utxo.token?.category !== paryonTokenId) return sum;
    return sum + toBigInt(utxo.token.amount ?? 0);
  }, 0n);

  return {
    bchSats,
    pusdAtomic,
    spendableUtxoCount: spendable.length,
    tokenUtxoCount: tokenUtxos.length,
  };
}

export async function loadParyonNativeSnapshot(
  sdk: AddonSDK,
  snapshot: ParyonWorkspaceSnapshot
): Promise<ParyonNativeSnapshot> {
  const [walletResult, latestBlock, priceContract, borrowingContract, stabilityPool, redeemer, loanKeyFactory] =
    await Promise.all([
      sdk.utxos.listForWallet(),
      safeGetLatestBlock(sdk),
      queryContractState(sdk, snapshot, 'PriceContract'),
      queryContractState(sdk, snapshot, 'Borrowing'),
      queryContractState(sdk, snapshot, 'StabilityPool'),
      queryContractState(sdk, snapshot, 'Redeemer'),
      queryContractState(sdk, snapshot, 'LoanKeyFactory'),
    ]);

  const balances = summarizeBalances(
    walletResult.allUtxos,
    walletResult.tokenUtxos,
    snapshot.config.tokenIds.paryonTokenId
  );
  const positionIndex = indexParyonPositions(walletResult.allUtxos);
  const liveContracts: Record<ParyonLiveThreadContractName, ParyonLiveContractState> = {
    PriceContract: priceContract,
    Borrowing: borrowingContract,
    StabilityPool: stabilityPool,
    Redeemer: redeemer,
    LoanKeyFactory: loanKeyFactory,
  };
  const threadHealth = deriveParyonThreadHealth(liveContracts);
  const chainHeight = latestBlock;
  const currentPeriod = stabilityPool.latestCommitment
    ? parseStabilityPoolState(stabilityPool.latestCommitment).currentPeriod
    : null;
  const expectedPeriod = deriveExpectedPeriod(chainHeight, snapshot.config);
  const periodDeltaPeriods =
    currentPeriod != null && expectedPeriod != null
      ? currentPeriod - expectedPeriod
      : null;
  const freshThreads = threadHealth.filter((thread) => thread.freshness === 'fresh').length;
  const degradedThreads = threadHealth.filter((thread) => thread.freshness === 'degraded').length;
  const staleThreads = threadHealth.filter((thread) => thread.freshness !== 'fresh').length;
  const systemHealth = {
    ...buildDefaultSystemHealth(threadHealth),
    chainHeight,
    expectedPeriod,
    periodDeltaPeriods,
    canWrite:
      snapshot.readiness === 'ready' &&
      snapshot.verifiedMainnetV1 &&
      freshThreads === threadHealth.length &&
      periodDeltaPeriods === 0,
    freshThreads,
    degradedThreads,
    staleThreads,
  } satisfies ParyonSystemHealth;

  const oraclePriceCentsPerBch = parseOraclePriceCentsPerBch(
    priceContract.latestCommitment
  );
  const stabilityPoolState = parseStabilityPoolState(stabilityPool.latestCommitment);
  const market = {
    oraclePriceCentsPerBch,
    currentPeriod: stabilityPoolState.currentPeriod,
    currentEpoch:
      stabilityPoolState.currentPeriod != null
        ? Math.floor(stabilityPoolState.currentPeriod / 10)
        : null,
    chainHeight,
    expectedPeriod,
    periodDeltaPeriods,
    writeEnabled: systemHealth.canWrite,
    verifiedMainnetV1: snapshot.verifiedMainnetV1,
  };
  const flowPlans = buildParyonFlowPlans({
    snapshot: {
      readiness: snapshot.readiness,
      verifiedMainnetV1: snapshot.verifiedMainnetV1,
    },
    market,
    positionIndex,
    threadHealth,
  });
  const warnings = [...new Set(threadHealth.flatMap((thread) => thread.warnings))];

  return {
    balances,
    market,
    liveContracts,
    positions: {
      loans: positionIndex.summary.loans,
      stakes: positionIndex.summary.stabilityPool,
      redemptions: positionIndex.summary.redemptions,
    },
    positionIndex,
    threadHealth,
    systemHealth,
    flowPlans,
    walletUtxos: walletResult.allUtxos,
    tokenUtxos: walletResult.tokenUtxos,
    warnings,
    loadedAt: Date.now(),
  };
}

function parsePusdAtomicAmount(input: string): bigint | null {
  const trimmed = input.trim().replace(/,/g, '');
  if (!trimmed) return null;
  const match = trimmed.match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) return null;
  const whole = BigInt(match[1]);
  const fraction = BigInt((match[2] ?? '').padEnd(2, '0') || '0');
  return whole * 100n + fraction;
}

function parseBchInputToSats(input: string): bigint | null {
  const trimmed = input.trim().replace(/,/g, '');
  if (!trimmed) return null;
  const match = trimmed.match(/^(\d+)(?:\.(\d{1,8}))?$/);
  if (!match) return null;
  const whole = BigInt(match[1]);
  const fraction = BigInt((match[2] ?? '').padEnd(8, '0') || '0');
  return whole * 100_000_000n + fraction;
}

function requireVerifiedMainnet(
  snapshot: ParyonWorkspaceSnapshot,
  market: ParyonLiveMarketState
): string | null {
  if (snapshot.readiness !== 'ready') return 'Deployment config is missing.';
  if (!snapshot.verifiedMainnetV1) return 'Live write flows are only enabled for verified mainnet-v1.';
  if (!market.writeEnabled) {
    return 'Live contract threads or period freshness are stale.';
  }
  return null;
}

export function buildBorrowPreview(params: {
  snapshot: ParyonWorkspaceSnapshot;
  market: ParyonLiveMarketState;
  borrowAmountText: string;
  collateralBchText: string;
}): ParyonActionPreview {
  const amountAtomic = parsePusdAtomicAmount(params.borrowAmountText);
  const collateralSats = parseBchInputToSats(params.collateralBchText);
  const oraclePrice = params.market.oraclePriceCentsPerBch;
  const gatingReason = requireVerifiedMainnet(params.snapshot, params.market);
  const warnings: string[] = [];
  const details: string[] = [];

  if (amountAtomic == null) warnings.push('Enter a valid PUSD amount.');
  if (collateralSats == null) warnings.push('Enter a valid BCH collateral amount.');
  if (amountAtomic != null && amountAtomic < 100n * 100n) {
    warnings.push('Borrow minimum is 100.00 PUSD.');
  }
  if (oraclePrice == null) warnings.push('Oracle price is unavailable.');

  const minimumCollateralSats =
    amountAtomic != null && oraclePrice != null && oraclePrice > 0n
      ? ((amountAtomic * 100_000_000n * 110n) +
          (100n * oraclePrice - 1n)) /
        (100n * oraclePrice)
      : null;

  const estimatedBorrowedValueSats =
    amountAtomic != null && oraclePrice != null && oraclePrice > 0n
      ? (amountAtomic * 100_000_000n) / oraclePrice
      : null;

  const estimatedFeeSats =
    estimatedBorrowedValueSats != null
      ? ((estimatedBorrowedValueSats * 25n) + 9_999n) / 10_000n
      : null;

  if (collateralSats != null && minimumCollateralSats != null && collateralSats < minimumCollateralSats) {
    warnings.push('Collateral is below the minimum 110% threshold.');
  }

  if (minimumCollateralSats != null) {
    details.push(`Minimum collateral: ${formatBchSats(minimumCollateralSats)}`);
  }
  if (estimatedFeeSats != null) {
    details.push(`Estimated borrowing fee: ${formatBchSats(estimatedFeeSats < 1000n ? 1000n : estimatedFeeSats)}`);
  }
  if (oraclePrice != null) {
    details.push(`Oracle price: ${formatUsdCents(oraclePrice)} / BCH`);
  }
  if (collateralSats != null) {
    details.push(`Collateral entered: ${formatBchSats(collateralSats)}`);
  }
  details.push('Launch-phase borrow flow keeps the native wallet in charge of confirmations.');

  const canProceed =
    !gatingReason &&
    warnings.length === 0 &&
    amountAtomic != null &&
    collateralSats != null;

  return {
    action: 'borrow',
    title: 'Loan',
    amountAtomic,
    amountLabel: amountAtomic != null ? formatPusdAtomic(amountAtomic) : 'Enter amount',
    primaryMetricLabel: 'Minimum collateral',
    primaryMetricValue:
      minimumCollateralSats != null ? formatBchSats(minimumCollateralSats) : 'Awaiting price',
    secondaryMetricLabel: 'Collateral entered',
    secondaryMetricValue:
      collateralSats != null ? formatBchSats(collateralSats) : 'Enter collateral',
    details,
    warnings,
    canProceed,
    blockedReason: gatingReason,
  };
}

export function buildStakePreview(params: {
  snapshot: ParyonWorkspaceSnapshot;
  market: ParyonLiveMarketState;
  stakeAmountText: string;
}): ParyonActionPreview {
  const amountAtomic = parsePusdAtomicAmount(params.stakeAmountText);
  const gatingReason = requireVerifiedMainnet(params.snapshot, params.market);
  const warnings: string[] = [];
  const details: string[] = [];

  if (amountAtomic == null) warnings.push('Enter a valid PUSD amount.');
  if (amountAtomic != null && amountAtomic < 100n * 100n) {
    warnings.push('Stake minimum is 100.00 PUSD.');
  }

  const currentEpoch = params.market.currentEpoch;
  const nextEpoch = currentEpoch != null ? currentEpoch + 1 : null;

  if (currentEpoch != null) {
    details.push(`Current epoch: ${currentEpoch}`);
  }
  if (nextEpoch != null) {
    details.push(`Receipt unlocks in epoch: ${nextEpoch}`);
  }
  details.push('Staked funds earn from the next epoch boundary onward.');
  details.push('Withdrawals are pro-rata and remain native to the wallet.');

  const canProceed = !gatingReason && warnings.length === 0 && amountAtomic != null;

  return {
    action: 'stake',
    title: 'Stability Pool',
    amountAtomic,
    amountLabel: amountAtomic != null ? formatPusdAtomic(amountAtomic) : 'Enter amount',
    primaryMetricLabel: 'Receipt epoch',
    primaryMetricValue: nextEpoch != null ? String(nextEpoch) : 'Awaiting pool state',
    secondaryMetricLabel: 'Minimum stake',
    secondaryMetricValue: formatPusdAtomic(100n * 100n),
    details,
    warnings,
    canProceed,
    blockedReason: gatingReason,
  };
}

export function buildRedeemPreview(params: {
  snapshot: ParyonWorkspaceSnapshot;
  market: ParyonLiveMarketState;
  redeemAmountText: string;
}): ParyonActionPreview {
  const amountAtomic = parsePusdAtomicAmount(params.redeemAmountText);
  const gatingReason = requireVerifiedMainnet(params.snapshot, params.market);
  const warnings: string[] = [];
  const details: string[] = [];

  if (amountAtomic == null) warnings.push('Enter a valid PUSD amount.');
  if (amountAtomic != null && amountAtomic < 100n * 100n) {
    warnings.push('Redeem minimum is 100.00 PUSD.');
  }

  const oraclePrice = params.market.oraclePriceCentsPerBch;
  const redemptionPrice =
    oraclePrice != null ? (oraclePrice * 1005n + 999n) / 1000n : null;
  const estimatedPayoutSats =
    amountAtomic != null && redemptionPrice != null && redemptionPrice > 0n
      ? (amountAtomic * 100_000_000n) / redemptionPrice
      : null;

  if (oraclePrice == null) warnings.push('Oracle price is unavailable.');
  if (estimatedPayoutSats != null && estimatedPayoutSats < 1000n) {
    warnings.push('Redemption output would be below dust.');
  }

  if (oraclePrice != null) {
    details.push(`Oracle price: ${formatUsdCents(oraclePrice)} / BCH`);
  }
  if (redemptionPrice != null) {
    details.push(`Redemption price: ${formatUsdCents(redemptionPrice)} / BCH`);
  }
  if (estimatedPayoutSats != null) {
    details.push(`Estimated BCH payout: ${formatBchSats(estimatedPayoutSats)}`);
  }
  details.push('Redemptions finalize after a 12-block timelock.');
  details.push('The wallet keeps the redemption flow fully native.');

  const canProceed = !gatingReason && warnings.length === 0 && amountAtomic != null;

  return {
    action: 'redeem',
    title: 'Redemption',
    amountAtomic,
    amountLabel: amountAtomic != null ? formatPusdAtomic(amountAtomic) : 'Enter amount',
    primaryMetricLabel: 'Estimated BCH payout',
    primaryMetricValue:
      estimatedPayoutSats != null ? formatBchSats(estimatedPayoutSats) : 'Awaiting price',
    secondaryMetricLabel: 'Finalization delay',
    secondaryMetricValue: '12 blocks',
    details,
    warnings,
    canProceed,
    blockedReason: gatingReason,
  };
}

export function buildWalletHistoryLines(walletUtxos: UTXO[]): string[] {
  return [...walletUtxos]
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0))
    .slice(0, 12)
    .map((utxo) => {
      const name = utxo.contractName ?? 'Standard UTXO';
      const value = formatBchSats(toBigInt(utxo.value ?? utxo.amount ?? 0));
      const token = utxo.token
        ? `${utxo.token.category.slice(0, 8)}${utxo.token.nft ? ` • NFT` : ''}`
        : 'No token';
      return `${name} · ${value} · ${token}`;
    });
}

export function buildParyonReadinessCopy(snapshot: ParyonWorkspaceSnapshot): {
  label: string;
  subtitle: string;
  actionLabel: string;
} {
  if (snapshot.readiness !== 'ready') {
    return {
      label: 'Deployment config missing',
      subtitle: 'Fill the deployment values to unlock native write flows.',
      actionLabel: 'Set deployment config',
    };
  }

  if (snapshot.verifiedMainnetV1) {
    return {
      label: 'Verified live mainnet-v1',
      subtitle: 'The wallet is matched to the live stablecoin bundle.',
      actionLabel: 'Open stablecoin actions',
    };
  }

  return {
    label: 'Configured deployment',
    subtitle: 'Inputs are present, but this does not match the verified live bundle.',
    actionLabel: 'Review deployment',
  };
}
