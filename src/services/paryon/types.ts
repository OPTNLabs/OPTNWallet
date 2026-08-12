export type ParyonNetwork = 'mainnet' | 'chipnet';

export type ParyonDeploymentTokenIds = {
  paryonTokenId: string;
  poolTokenId: string;
  redeemerTokenId: string;
  loanKeyFactoryTokenId: string;
  oracleMigrationKeyTokenId: string;
};

export type ParyonDeploymentConfig = {
  network: ParyonNetwork;
  oraclePublicKey: string;
  protocolFeeLockingBytecode: string;
  startBlockHeight: number;
  periodLengthBlocks: number;
  timeLockRedemption: number;
  tokenIds: ParyonDeploymentTokenIds;
};

export type ParyonDeploymentProfile = 'mainnet-v1' | 'custom' | 'chipnet';

export type ParyonThreadFreshness = 'fresh' | 'degraded' | 'stale' | 'missing';

export type ParyonPositionKind =
  | 'loan'
  | 'stability-pool'
  | 'redemption'
  | 'authority'
  | 'system';

export type ParyonPositionState = 'live' | 'pending' | 'locked' | 'inactive' | 'unknown';

export type ParyonPositionRecord = {
  kind: ParyonPositionKind;
  positionId: string;
  txHash: string;
  outputIndexes: number[];
  contractNames: string[];
  tokenCategories: string[];
  tokenAmountAtomic: bigint | null;
  valueSats: bigint;
  capability: 'none' | 'mutable' | 'minting' | null;
  state: ParyonPositionState;
  label: string;
  details: string[];
  warnings: string[];
};

export type ParyonPositionIndex = {
  loans: ParyonPositionRecord[];
  stabilityPool: ParyonPositionRecord[];
  redemptions: ParyonPositionRecord[];
  authorities: ParyonPositionRecord[];
  system: ParyonPositionRecord[];
  summary: {
    loans: number;
    stabilityPool: number;
    redemptions: number;
    authorities: number;
    system: number;
    total: number;
  };
};

export type ParyonThreadHealth = {
  name: ParyonContractBundleName;
  tokenId: string;
  preferredOutpoint: string | null;
  threadCount: number;
  freshness: ParyonThreadFreshness;
  warnings: string[];
};

export type ParyonFlowSubplan = {
  name: string;
  summary: string;
  ready: boolean;
  blockedReason: string | null;
  steps: string[];
  requirements: string[];
  warnings: string[];
};

export type ParyonFlowPlan = {
  key: 'loan' | 'pool' | 'redemption' | 'operator';
  title: string;
  summary: string;
  ready: boolean;
  blockedReason: string | null;
  warnings: string[];
  subplans: ParyonFlowSubplan[];
};

export type ParyonFlowPlanGroup = {
  loan: ParyonFlowPlan;
  pool: ParyonFlowPlan;
  redemption: ParyonFlowPlan;
  operator: ParyonFlowPlan;
};

export type ParyonSystemHealth = {
  chainHeight: number | null;
  expectedPeriod: number | null;
  periodDeltaPeriods: number | null;
  canWrite: boolean;
  freshThreads: number;
  degradedThreads: number;
  staleThreads: number;
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
  freshness: ParyonThreadFreshness;
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

export type ParyonContractBundleName =
  | 'Borrowing'
  | 'Loan'
  | 'LoanSidecar'
  | 'PriceContract'
  | 'LoanKeyFactory'
  | 'LoanKeyOriginEnforcer'
  | 'LoanKeyOriginProof'
  | 'Redemption'
  | 'RedemptionSidecar'
  | 'Redeemer'
  | 'StabilityPool'
  | 'StabilityPoolSidecar'
  | 'Collector'
  | 'Payout'
  | 'AddLiquidity'
  | 'LiquidateLoan'
  | 'NewPeriodPool'
  | 'WithdrawFromPool'
  | 'liquidate'
  | 'manage'
  | 'redeem'
  | 'startRedemption'
  | 'swapInRedemption'
  | 'swapOutRedemption'
  | 'payInterest'
  | 'changeInterest';

export type ParyonContractDescriptor = {
  name: ParyonContractBundleName;
  artifact: unknown;
};

export type ParyonReadinessState = 'ready' | 'missing-config';

export type ParyonNativeView =
  | 'dashboard'
  | 'borrow'
  | 'stake'
  | 'redeem'
  | 'history'
  | 'stats'
  | 'faq'
  | 'docs';

export type ParyonActionKind = 'borrow' | 'stake' | 'redeem';

export type ParyonActionVariant =
  | 'borrow'
  | 'manageLoan'
  | 'stake'
  | 'withdraw'
  | 'claim'
  | 'redeem'
  | 'swap'
  | 'finalize'
  | 'cancel';

export type ParyonExecutionTarget = {
  positionId: string;
  txHash: string;
  kind: ParyonPositionKind;
  label: string;
  state: ParyonPositionState;
};

export type ParyonExecutionPlan = {
  action: ParyonActionVariant;
  ready: boolean;
  blockedReason: string | null;
  target: ParyonExecutionTarget | null;
  summary: string;
  outputTemplate: string[];
  validation: string[];
  warnings: string[];
};

export type ParyonWorkspaceSection =
  | 'overview'
  | 'balances'
  | 'actions'
  | 'deployment'
  | 'system-map'
  | 'resources'
  | 'debug';

export type ParyonDerivedContractNode = {
  name: ParyonContractBundleName;
  address: string;
  lockingBytecodeHex: string;
  constructorInputs: unknown[];
  abiNames: string[];
  resolved: boolean;
  resolutionError?: string;
};

export type ParyonWorkspacePrimaryAction = {
  label: string;
  targetSection: Extract<ParyonWorkspaceSection, 'actions' | 'deployment' | 'system-map'>;
};

export type ParyonWorkspaceSnapshot = {
  network: ParyonNetwork;
  config: ParyonDeploymentConfig;
  validationErrors: string[];
  missingFields: string[];
  readiness: ParyonReadinessState;
  deploymentProfile: ParyonDeploymentProfile;
  verifiedMainnetV1: boolean;
  verificationLabel: string;
  verificationSummary: string;
  primaryAction: ParyonWorkspacePrimaryAction;
  artifactNames: ParyonContractBundleName[];
  contractCount: number;
  contracts: ParyonDerivedContractNode[];
  contractsByName: Record<ParyonContractBundleName, ParyonDerivedContractNode>;
};
