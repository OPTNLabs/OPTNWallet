import type { QuantumrootVaultRecord, UTXO } from '../types/types';
import { isPlainNftToken } from './cashtokens';

export type QuantumrootTokenAwareness = {
  configuredTokenCategory: string | null;
  hasConfiguredTokenCategory: boolean;
  matchingControlTokenUtxos: UTXO[];
  matchingReceiveTokenUtxos: UTXO[];
  unrelatedQuantumLockTokenUtxos: UTXO[];
  tokenizedReceiveUtxos: UTXO[];
  canAuthorizedSpend: boolean;
  readinessLabel: string;
};

const PLACEHOLDER_CATEGORY = '00'.repeat(32);

function normalizeCategory(category: string | null | undefined) {
  const normalized = (category ?? '').trim().toLowerCase();
  return normalized.length === 64 ? normalized : null;
}

export function isConfiguredQuantumrootTokenCategory(category: string | null | undefined) {
  const normalized = normalizeCategory(category);
  return normalized !== null && normalized !== PLACEHOLDER_CATEGORY;
}

export function summarizeQuantumrootTokenAwareness(
  vault: QuantumrootVaultRecord,
  receiveUtxos: UTXO[],
  quantumLockUtxos: UTXO[]
): QuantumrootTokenAwareness {
  const configuredTokenCategory = normalizeCategory(vault.vault_token_category);
  const hasConfiguredTokenCategory = isConfiguredQuantumrootTokenCategory(
    vault.vault_token_category
  );

  const tokenizedReceiveUtxos = receiveUtxos.filter((utxo) =>
    isPlainNftToken(utxo.token)
  );
  const quantumLockTokenUtxos = quantumLockUtxos.filter((utxo) =>
    isPlainNftToken(utxo.token)
  );

  const matchingControlTokenUtxos = hasConfiguredTokenCategory
    ? quantumLockTokenUtxos.filter(
        (utxo) => normalizeCategory(utxo.token?.category) === configuredTokenCategory
      )
    : [];
  const matchingReceiveTokenUtxos = hasConfiguredTokenCategory
    ? tokenizedReceiveUtxos.filter(
        (utxo) => normalizeCategory(utxo.token?.category) === configuredTokenCategory
      )
    : [];

  const unrelatedQuantumLockTokenUtxos = quantumLockTokenUtxos.filter(
    (utxo) => normalizeCategory(utxo.token?.category) !== configuredTokenCategory
  );

  const canAuthorizedSpend =
    hasConfiguredTokenCategory &&
    matchingControlTokenUtxos.length > 0 &&
    matchingReceiveTokenUtxos.length > 0;

  const readinessLabel = !hasConfiguredTokenCategory
    ? 'Choose an approval key'
    : matchingControlTokenUtxos.length === 0
      ? 'Waiting for the approval key'
      : matchingReceiveTokenUtxos.length === 0
        ? 'Waiting for the matching receive coin'
        : 'Ready to spend';

  return {
    configuredTokenCategory,
    hasConfiguredTokenCategory,
    matchingControlTokenUtxos,
    matchingReceiveTokenUtxos,
    unrelatedQuantumLockTokenUtxos,
    tokenizedReceiveUtxos,
    canAuthorizedSpend,
    readinessLabel,
  };
}
