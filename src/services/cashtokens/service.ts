import type { UTXO } from '../../types/types';
import type {
  CapabilityEligibility,
  CapabilityOutputDraft,
  CapabilitySourceUtxo,
  MintPlan,
  MintPlanSourceGroup,
  MutationPlan,
  NftTransitionCheck,
  NftTransitionResult,
  TokenCapability,
  TokenFamilySummary,
} from './types';

function normalizeCategory(category: string | null | undefined): string {
  return String(category ?? '').trim().replace(/^0x/i, '').toLowerCase();
}

function normalizeCapability(
  capability: string | null | undefined
): TokenCapability | null {
  if (capability === 'none' || capability === 'mutable' || capability === 'minting') {
    return capability;
  }
  return null;
}

function toBigIntAmount(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return BigInt(Math.trunc(value));
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return 0n;
    try {
      return BigInt(trimmed);
    } catch {
      return 0n;
    }
  }
  return 0n;
}

function buildUtxoKey(utxo: Pick<UTXO, 'tx_hash' | 'tx_pos'>): string {
  return `${utxo.tx_hash}:${utxo.tx_pos}`;
}

function dedupeTokenUtxos(utxos: UTXO[]): UTXO[] {
  const seen = new Set<string>();
  const deduped: UTXO[] = [];

  for (const utxo of utxos) {
    if (!utxo.token?.category) continue;
    const key = buildUtxoKey(utxo);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(utxo);
  }

  return deduped;
}

function sortFamilies(left: TokenFamilySummary, right: TokenFamilySummary): number {
  if (left.plainNftUtxoCount !== right.plainNftUtxoCount) {
    return right.plainNftUtxoCount - left.plainNftUtxoCount;
  }
  if (left.nftUtxoCount !== right.nftUtxoCount) {
    return right.nftUtxoCount - left.nftUtxoCount;
  }
  if (left.tokenUtxoCount !== right.tokenUtxoCount) {
    return right.tokenUtxoCount - left.tokenUtxoCount;
  }
  if (left.totalAtomicAmount !== right.totalAtomicAmount) {
    return left.totalAtomicAmount > right.totalAtomicAmount ? -1 : 1;
  }
  return left.category.localeCompare(right.category);
}

export function getTokenCapability(token: UTXO['token'] | null | undefined) {
  return normalizeCapability(token?.nft?.capability ?? null);
}

export function isPlainNftToken(token: UTXO['token'] | null | undefined) {
  return !!token?.nft && getTokenCapability(token) === 'none';
}

export function isMutableNftToken(token: UTXO['token'] | null | undefined) {
  return !!token?.nft && getTokenCapability(token) === 'mutable';
}

export function isMintingNftToken(token: UTXO['token'] | null | undefined) {
  return !!token?.nft && getTokenCapability(token) === 'minting';
}

export function summarizeTokenFamilies(utxos: UTXO[]): TokenFamilySummary[] {
  const summaryByCategory = new Map<string, TokenFamilySummary>();

  for (const utxo of dedupeTokenUtxos(utxos)) {
    const token = utxo.token;
    if (!token?.category) continue;

    const category = normalizeCategory(token.category);
    if (!category) continue;

    const current = summaryByCategory.get(category) ?? {
      category,
      totalAtomicAmount: 0n,
      tokenUtxoCount: 0,
      fungibleUtxoCount: 0,
      nftUtxoCount: 0,
      plainNftUtxoCount: 0,
      mutableNftUtxoCount: 0,
      mintingNftUtxoCount: 0,
      capabilities: [],
    };

    current.totalAtomicAmount += toBigIntAmount(token.amount);
    current.tokenUtxoCount += 1;

    const capability = getTokenCapability(token);
    if (capability) {
      current.nftUtxoCount += 1;
      if (capability === 'none') current.plainNftUtxoCount += 1;
      if (capability === 'mutable') current.mutableNftUtxoCount += 1;
      if (capability === 'minting') current.mintingNftUtxoCount += 1;
      if (!current.capabilities.includes(capability)) {
        current.capabilities = [...current.capabilities, capability].sort();
      }
    } else {
      current.fungibleUtxoCount += 1;
    }

    summaryByCategory.set(category, current);
  }

  return Array.from(summaryByCategory.values()).sort(sortFamilies);
}

export function buildCapabilityEligibility(
  family: TokenFamilySummary,
  requestedCapability: TokenCapability
): CapabilityEligibility {
  const hasRequestedCapability =
    requestedCapability === 'none'
      ? family.plainNftUtxoCount > 0
      : requestedCapability === 'mutable'
        ? family.mutableNftUtxoCount > 0
        : family.mintingNftUtxoCount > 0;

  const blockers: string[] = [];
  if (!family.nftUtxoCount) {
    blockers.push('Category has no NFT holdings.');
  }
  if (!hasRequestedCapability) {
    blockers.push(`Category does not contain a ${requestedCapability} NFT.`);
  }

  return {
    category: family.category,
    requestedCapability,
    availableCapabilities: family.capabilities,
    hasRequestedCapability,
    hasAnyNft: family.nftUtxoCount > 0,
    hasFungibleHoldings: family.fungibleUtxoCount > 0,
    canUseForQuantumroot: requestedCapability === 'none' && hasRequestedCapability,
    blockers,
  };
}

function describeSource({
  source,
  sourceKey,
}: {
  source: CapabilitySourceUtxo;
  sourceKey: string;
}): MintPlanSourceGroup {
  const sourceCapability = getTokenCapability(source.token);
  const category = normalizeCategory(source.token?.category ?? source.tx_hash);
  return {
    sourceKey,
    category,
    sourceCapability,
    nftOutputCount: 0,
    fungibleOutputCount: 0,
    outputCount: 0,
    requestedCapabilities: [],
  };
}

export function validateNftCapabilityTransition(
  check: NftTransitionCheck
): NftTransitionResult {
  const { sourceCapability, sourceCommitment, requestedCapability, requestedCommitment, outputCount } =
    check;

  if (!sourceCapability) {
    return { ok: true };
  }

  if (sourceCapability === 'none') {
    if (outputCount > 1) {
      return {
        ok: false,
        message: 'A plain NFT source can only recreate one NFT output.',
      };
    }
    if (
      requestedCapability !== undefined &&
      requestedCapability !== null &&
      requestedCapability !== 'none'
    ) {
      return {
        ok: false,
        message:
          'A plain NFT source cannot change NFT capability.',
      };
    }
    if (
      requestedCommitment !== undefined &&
      requestedCommitment !== null &&
      sourceCommitment !== undefined &&
      requestedCommitment !== sourceCommitment
    ) {
      return {
        ok: false,
        message:
          'A plain NFT source cannot change its commitment when spent.',
      };
    }
    return { ok: true };
  }

  if (sourceCapability === 'mutable') {
    if (outputCount > 1) {
      return {
        ok: false,
        message: 'A mutable NFT source can only recreate one NFT output.',
      };
    }
    if (requestedCapability === 'minting') {
      return {
        ok: false,
        message:
          'A mutable NFT source can only recreate immutable or mutable NFT outputs.',
      };
    }
    return { ok: true };
  }

  if (sourceCapability === 'minting') {
    return { ok: true };
  }

  return {
    ok: false,
    message: `Unsupported NFT capability: ${String(sourceCapability)}`,
  };
}

export function buildMintPlan({
  outputs,
  sourceByKey,
}: {
  outputs: CapabilityOutputDraft[];
  sourceByKey: ReadonlyMap<string, CapabilitySourceUtxo>;
}): MintPlan {
  const sourceGroups = new Map<string, MintPlanSourceGroup>();
  const blockers: string[] = [];

  for (const output of outputs) {
    const source = sourceByKey.get(output.sourceKey);
    if (!source) {
      blockers.push(
        `Output ${output.id} references an unselected source UTXO.`
      );
      continue;
    }

    const group =
      sourceGroups.get(output.sourceKey) ?? describeSource({
        source,
        sourceKey: output.sourceKey,
      });
    group.outputCount += 1;

    if (output.kind === 'nft') {
      group.nftOutputCount += 1;
      if (!output.nftCapability) {
        blockers.push(`NFT output ${output.id} is missing a capability.`);
      }
      if (output.nftCommitment === undefined) {
        blockers.push(`NFT output ${output.id} is missing a commitment.`);
      }
      if (output.nftCapability) {
        group.requestedCapabilities = [
          ...group.requestedCapabilities,
          output.nftCapability,
        ];
      }
    } else {
      group.fungibleOutputCount += 1;
      const amount = toBigIntAmount(output.fungibleAmount);
      if (amount <= 0n) {
        blockers.push(`FT output ${output.id} must have a positive amount.`);
      }
    }

    sourceGroups.set(output.sourceKey, group);
  }

  for (const group of sourceGroups.values()) {
    const source = sourceByKey.get(group.sourceKey);
    if (!source) continue;
    const sourceToken = source.token ?? null;
    const sourceCapability = getTokenCapability(sourceToken);

    const isGenesisSource = !sourceToken && source.tx_pos === 0;
    if (isGenesisSource) {
      continue;
    }

    if (!sourceToken?.nft) {
      if (group.nftOutputCount > 0) {
        blockers.push(
          `Source ${group.sourceKey} does not carry NFT authority for NFT outputs.`
        );
      }
      if (group.fungibleOutputCount > 0 && !isGenesisSource) {
        blockers.push(
          `Source ${group.sourceKey} cannot yet plan fungible outputs from a non-genesis source.`
        );
      }
      continue;
    }

    const nftOutputsForSource = outputs.filter(
      (output) => output.sourceKey === group.sourceKey && output.kind === 'nft'
    );

    for (const output of nftOutputsForSource) {
      const capabilityCheck = validateNftCapabilityTransition({
        sourceCapability,
        sourceCommitment: sourceToken.nft.commitment,
        requestedCapability: output.nftCapability ?? null,
        requestedCommitment: output.nftCommitment ?? null,
        outputCount: group.nftOutputCount,
      });
      if (capabilityCheck.ok === false) {
        blockers.push(
          `Source ${group.sourceKey} is not valid for NFT output ${output.id}: ${
            'message' in capabilityCheck
              ? capabilityCheck.message
              : 'Capability validation failed.'
          }`
        );
      }
    }

    if (group.fungibleOutputCount > 0) {
      blockers.push(
        `Source ${group.sourceKey} cannot yet plan fungible outputs from an NFT authority source.`
      );
    }
  }

  return {
    sourceGroups: Array.from(sourceGroups.values()),
    blockers,
    ready: blockers.length === 0,
  };
}

export function buildMutationPlan({
  source,
  sourceKey,
  requestedCapability,
  outputCount,
  requestedCommitment,
}: {
  source: CapabilitySourceUtxo;
  sourceKey: string;
  requestedCapability: TokenCapability | null;
  outputCount: number;
  requestedCommitment?: string | null;
}): MutationPlan {
  const sourceCapability = getTokenCapability(source.token);
  const category = normalizeCategory(
    source.token?.category ?? source.tx_hash
  );
  const sourceCommitment = source.token?.nft?.commitment ?? null;
  const blockers: string[] = [];

  const capabilityCheck = validateNftCapabilityTransition({
    sourceCapability,
    sourceCommitment,
    requestedCapability,
    requestedCommitment,
    outputCount,
  });
  if (capabilityCheck.ok === false) {
    blockers.push(
      'message' in capabilityCheck
        ? capabilityCheck.message
        : 'Capability validation failed.'
    );
  }

  return {
    sourceKey,
    category,
    sourceCapability,
    requestedCapability,
    outputCount,
    blockers,
    ready: blockers.length === 0,
  };
}

export function validateCapabilityAwareMintDrafts({
  outputs,
  sourceByKey,
}: {
  outputs: CapabilityOutputDraft[];
  sourceByKey: ReadonlyMap<string, CapabilitySourceUtxo>;
}): { ok: true } | { ok: false; message: string } {
  const mintPlan = buildMintPlan({ outputs, sourceByKey });
  if (!mintPlan.ready) {
    return {
      ok: false,
      message: mintPlan.blockers[0] ?? 'Capability validation failed.',
    };
  }
  return { ok: true };
}

export function normalizeTokenFamilyKey(category: string): string {
  return normalizeCategory(category);
}

export function getCapabilityAwareFamilies(utxos: UTXO[]) {
  return summarizeTokenFamilies(utxos).filter((family) => family.nftUtxoCount > 0);
}
