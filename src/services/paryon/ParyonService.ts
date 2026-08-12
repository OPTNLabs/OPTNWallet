import { Contract, ElectrumNetworkProvider } from 'cashscript';

import { PARYON_ARTIFACTS, listParyonArtifactNames } from './artifacts';
import {
  PARYON_MAINNET_V1_DEPLOYMENT,
  getParyonDeploymentConfig,
  validateParyonDeploymentConfig,
} from './config';
import type {
  ParyonContractBundleName,
  ParyonDerivedContractNode,
  ParyonDeploymentConfig,
  ParyonDeploymentProfile,
  ParyonNetwork,
  ParyonWorkspaceSnapshot,
} from './types';
import parseInputValue from '../../utils/parseInputValue';
import { binToHex } from '../../utils/hex';

type ContractResolveContext = {
  config: ParyonDeploymentConfig;
  provider: ElectrumNetworkProvider;
  memo: Map<ParyonContractBundleName, ParyonDerivedContractNode>;
};

export const PARYON_CORE_CONTRACTS: ParyonContractBundleName[] = [
  'PriceContract',
  'Borrowing',
  'StabilityPool',
  'Redeemer',
  'Collector',
  'NewPeriodPool',
  'LoanKeyFactory',
];

function toProviderNetwork(
  network: ParyonNetwork
): ConstructorParameters<typeof ElectrumNetworkProvider>[0] {
  return network === 'chipnet' ? 'chipnet' : 'mainnet';
}

function getConstructorInputType(
  artifact: unknown,
  index: number
): string | undefined {
  if (!artifact || typeof artifact !== 'object') return undefined;
  if (!('constructorInputs' in artifact)) return undefined;
  const constructorInputs = (
    artifact as { constructorInputs?: unknown }
  ).constructorInputs;
  if (!Array.isArray(constructorInputs)) return undefined;
  const input = constructorInputs[index];
  if (!input || typeof input !== 'object') return undefined;
  const type = (input as { type?: unknown }).type;
  return typeof type === 'string' ? type : undefined;
}

function normalizeHex(value: string): string {
  return value.trim().replace(/^0x/i, '').toLowerCase();
}

function contractBytecodeHex(contract: Contract): string {
  const bytecode = contract.bytecode;
  if (typeof bytecode === 'string') return normalizeHex(bytecode);
  return binToHex(bytecode as Uint8Array);
}

function asContractArtifact(name: ParyonContractBundleName): unknown {
  return PARYON_ARTIFACTS[name].artifact;
}

export function getParyonArtifact(name: ParyonContractBundleName): unknown {
  return asContractArtifact(name);
}

export function isVerifiedParyonMainnetDeployment(
  config: ParyonDeploymentConfig
): boolean {
  const live = PARYON_MAINNET_V1_DEPLOYMENT;
  return (
    config.network === 'mainnet' &&
    config.oraclePublicKey === live.oraclePublicKey &&
    config.protocolFeeLockingBytecode === live.protocolFeeLockingBytecode &&
    config.startBlockHeight === live.startBlockHeight &&
    config.periodLengthBlocks === live.periodLengthBlocks &&
    config.timeLockRedemption === live.timeLockRedemption &&
    config.tokenIds.paryonTokenId === live.tokenIds.paryonTokenId &&
    config.tokenIds.poolTokenId === live.tokenIds.poolTokenId &&
    config.tokenIds.redeemerTokenId === live.tokenIds.redeemerTokenId &&
    config.tokenIds.loanKeyFactoryTokenId ===
      live.tokenIds.loanKeyFactoryTokenId &&
    config.tokenIds.oracleMigrationKeyTokenId ===
      live.tokenIds.oracleMigrationKeyTokenId
  );
}

function resolveContractNameInputs(
  name: ParyonContractBundleName,
  ctx: ContractResolveContext
): unknown[] {
  switch (name) {
    case 'Borrowing':
      return [
        resolveParyonContractNode('Loan', ctx).lockingBytecodeHex,
        resolveParyonContractNode('LoanSidecar', ctx).lockingBytecodeHex,
        ctx.config.protocolFeeLockingBytecode,
        resolveParyonContractNode('LoanKeyOriginEnforcer', ctx)
          .lockingBytecodeHex,
        ctx.config.startBlockHeight,
        ctx.config.periodLengthBlocks,
      ];
    case 'Collector':
      return [
        ctx.config.tokenIds.paryonTokenId,
        ctx.config.protocolFeeLockingBytecode,
      ];
    case 'NewPeriodPool':
      return [
        resolveParyonContractNode('Payout', ctx).lockingBytecodeHex,
        resolveParyonContractNode('Collector', ctx).lockingBytecodeHex,
        ctx.config.startBlockHeight,
        ctx.config.periodLengthBlocks,
      ];
    case 'Redeemer':
      return [
        ctx.config.tokenIds.paryonTokenId,
        resolveParyonContractNode('Redemption', ctx).lockingBytecodeHex,
        resolveParyonContractNode('RedemptionSidecar', ctx)
          .lockingBytecodeHex,
      ];
    case 'LoanKeyFactory':
      return [
        resolveParyonContractNode('LoanKeyOriginEnforcer', ctx)
          .lockingBytecodeHex,
        resolveParyonContractNode('LoanKeyOriginProof', ctx).lockingBytecodeHex,
      ];
    case 'LoanKeyOriginEnforcer':
      return [
        ctx.config.tokenIds.loanKeyFactoryTokenId,
        ctx.config.tokenIds.paryonTokenId,
      ];
    case 'PriceContract':
      return [
        ctx.config.oraclePublicKey,
        ctx.config.tokenIds.oracleMigrationKeyTokenId,
      ];
    case 'StabilityPoolSidecar':
      return [ctx.config.tokenIds.paryonTokenId];
    case 'Redemption':
      return [ctx.config.tokenIds.paryonTokenId];
    case 'AddLiquidity':
      return [ctx.config.tokenIds.paryonTokenId];
    case 'LiquidateLoan':
      return [ctx.config.tokenIds.paryonTokenId];
    case 'liquidate':
      return [ctx.config.tokenIds.poolTokenId];
    case 'redeem':
      return [
        ctx.config.tokenIds.redeemerTokenId,
        ctx.config.timeLockRedemption,
        ctx.config.startBlockHeight,
        ctx.config.periodLengthBlocks,
      ];
    case 'startRedemption':
      return [ctx.config.tokenIds.redeemerTokenId];
    case 'swapInRedemption':
      return [ctx.config.tokenIds.redeemerTokenId];
    case 'swapOutRedemption':
      return [ctx.config.tokenIds.redeemerTokenId];
    case 'payInterest':
      return [ctx.config.tokenIds.poolTokenId];
    case 'manage':
    case 'changeInterest':
    case 'Loan':
    case 'LoanSidecar':
    case 'LoanKeyOriginProof':
    case 'Payout':
    case 'RedemptionSidecar':
    case 'StabilityPool':
    case 'WithdrawFromPool':
      return [];
    default:
      return [];
  }
}

function resolveParyonContractNode(
  name: ParyonContractBundleName,
  ctx: ContractResolveContext
): ParyonDerivedContractNode {
  const cached = ctx.memo.get(name);
  if (cached) return cached;

  const artifact = asContractArtifact(name);
  const rawInputs = resolveContractNameInputs(name, ctx);
  const parsedInputs = Array.isArray((artifact as { constructorInputs?: unknown[] }).constructorInputs)
    ? ((artifact as { constructorInputs: unknown[] }).constructorInputs ?? []).map(
        (_input, index) =>
          parseInputValue(
            rawInputs[index],
            getConstructorInputType(artifact, index) ?? 'bytes'
          )
      )
    : [];

  const fallbackNode: ParyonDerivedContractNode = {
    name,
    address: '(unresolved)',
    lockingBytecodeHex: '',
    constructorInputs: parsedInputs,
    abiNames: Array.isArray((artifact as { abi?: unknown[] }).abi)
      ? ((artifact as { abi: Array<{ name?: unknown }> }).abi ?? [])
          .map((entry) => (typeof entry?.name === 'string' ? entry.name : ''))
          .filter(Boolean)
      : [],
    resolved: false,
  };

  ctx.memo.set(name, fallbackNode);

  try {
    const contract = new Contract(
      artifact as never,
      parsedInputs as never,
      {
        provider: ctx.provider,
        addressType: 'p2sh32',
      }
    );
    const node: ParyonDerivedContractNode = {
      ...fallbackNode,
      address: contract.tokenAddress || contract.address || '(unresolved)',
      lockingBytecodeHex: contractBytecodeHex(contract),
      resolved: true,
    };
    ctx.memo.set(name, node);
    return node;
  } catch (error) {
    const node: ParyonDerivedContractNode = {
      ...fallbackNode,
      resolutionError:
        error instanceof Error ? error.message : 'Failed to derive contract',
    };
    ctx.memo.set(name, node);
    return node;
  }
}

export function resolveParyonContractGraph(
  config: ParyonDeploymentConfig
): ParyonDerivedContractNode[] {
  const provider = new ElectrumNetworkProvider(toProviderNetwork(config.network));
  const memo = new Map<ParyonContractBundleName, ParyonDerivedContractNode>();
  const ctx: ContractResolveContext = { config, provider, memo };

  return listParyonArtifactNames().map((name) =>
    resolveParyonContractNode(name, ctx)
  );
}

export function getParyonContractConstructorInputs(
  name: ParyonContractBundleName,
  config: ParyonDeploymentConfig
): unknown[] {
  const node = resolveParyonContractGraph(config).find((entry) => entry.name === name);
  return node?.constructorInputs ?? [];
}

function toPrimaryAction(
  readiness: 'ready' | 'missing-config',
  verifiedMainnetV1: boolean,
  deploymentProfile: ParyonDeploymentProfile
): {
  label: string;
  targetSection: 'actions' | 'deployment' | 'system-map';
} {
  if (readiness === 'missing-config') {
    return {
      label: 'Set deployment config',
      targetSection: 'deployment',
    };
  }

  if (verifiedMainnetV1) {
    return {
      label: 'Open stablecoin actions',
      targetSection: 'actions',
    };
  }

  if (deploymentProfile === 'chipnet') {
    return {
      label: 'Review deployment',
      targetSection: 'deployment',
    };
  }

  return {
    label: 'Review system map',
    targetSection: 'system-map',
  };
}

function describeVerification(
  readiness: 'ready' | 'missing-config',
  verifiedMainnetV1: boolean
): { label: string; summary: string } {
  if (verifiedMainnetV1) {
    return {
      label: 'Verified live mainnet-v1',
      summary:
        'Matches the official ParyonUSD live deployment bundle and token IDs.',
    };
  }

  if (readiness === 'ready') {
    return {
      label: 'Configured deployment',
      summary:
        'Deployment inputs validate, but this does not match the verified live mainnet-v1 bundle.',
    };
  }

  return {
    label: 'Needs deployment config',
    summary:
      'Fill the missing deployment values to unlock live contract verification.',
  };
}

export function resolveParyonWorkspaceSnapshot(
  network: string | null | undefined
): ParyonWorkspaceSnapshot {
  const config = getParyonDeploymentConfig(network);
  const validationErrors = validateParyonDeploymentConfig(config);
  const readiness = validationErrors.length > 0 ? 'missing-config' : 'ready';
  const verifiedMainnetV1 = isVerifiedParyonMainnetDeployment(config);
  const deploymentProfile: ParyonDeploymentProfile =
    config.network === 'chipnet'
      ? 'chipnet'
      : verifiedMainnetV1
        ? 'mainnet-v1'
        : 'custom';
  const verification = describeVerification(readiness, verifiedMainnetV1);
  const primaryAction = toPrimaryAction(
    readiness,
    verifiedMainnetV1,
    deploymentProfile
  );
  const contracts = resolveParyonContractGraph(config);
  const contractsByName = Object.fromEntries(
    contracts.map((contract) => [contract.name, contract])
  ) as Record<ParyonContractBundleName, ParyonDerivedContractNode>;

  return {
    network: config.network,
    config,
    validationErrors,
    missingFields: [...validationErrors],
    readiness,
    deploymentProfile,
    verifiedMainnetV1,
    verificationLabel: verification.label,
    verificationSummary: verification.summary,
    primaryAction,
    artifactNames: listParyonArtifactNames(),
    contractCount: listParyonArtifactNames().length,
    contracts,
    contractsByName,
  };
}

export { listParyonArtifactNames };
