import type {
  AddonContractDefinition,
  AddonManifest,
} from '../../types/addons';
import type { UTXO } from '../../types/types';

export type ParsedAddonKey = {
  addonId?: string;
  contractId?: string;
} | null;

export function parseJsonOr<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function normalizeAddonKey(key: string): ParsedAddonKey {
  if (!key.startsWith('addon:')) return null;

  const rest = key.slice('addon:'.length);
  if (!rest) return null;

  const parts = rest.split(':').filter(Boolean);
  if (parts.length === 1) return { contractId: parts[0] };
  if (parts.length >= 2) {
    return { addonId: parts[0], contractId: parts.slice(1).join(':') };
  }
  return null;
}

export function findAddonContract(
  manifests: AddonManifest[],
  addonId: string | undefined,
  contractId: string
): AddonContractDefinition | null {
  if (addonId) {
    const manifest = manifests.find((x) => x.id === addonId);
    if (!manifest) return null;
    return manifest.contracts.find((c) => c.id === contractId) || null;
  }

  for (const manifest of manifests) {
    const found = manifest.contracts.find((c) => c.id === contractId);
    if (found) return found;
  }
  return null;
}

export function serializeUnlockFunctions(unlock: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(unlock).map(([key, func]) => [
      key,
      (func as { toString: () => string }).toString(),
    ])
  );
}

export function reviveUnlockFunctions(unlock: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(unlock).map(([key, funcStr]) => [
      key,
      new Function(`return ${funcStr}`)(),
    ])
  );
}

export function toStoredContractUtxo(
  utxo: UTXO,
  prefix: string,
  emptyContractFieldsAsNull: boolean
) {
  return {
    tx_hash: utxo.tx_hash,
    tx_pos: utxo.tx_pos,
    amount: BigInt(utxo.value),
    height: utxo.height,
    token: utxo.token || undefined,
    prefix,
    contractFunction: emptyContractFieldsAsNull
      ? utxo.contractFunction || null
      : utxo.contractFunction || undefined,
    contractFunctionInputs: utxo.contractFunctionInputs
      ? JSON.stringify(utxo.contractFunctionInputs)
      : emptyContractFieldsAsNull
        ? null
        : undefined,
  };
}

export function outpointKey(txHash: string, txPos: number | string) {
  return `${txHash}:${txPos}`;
}

