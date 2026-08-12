import { isConfiguredQuantumrootTokenCategory } from '../../services/QuantumrootTokenAwarenessService';
import type { QuantumrootTokenAwareness } from '../../services/QuantumrootTokenAwarenessService';
import type { QuantumrootWalletTokenSummary } from '../../services/QuantumrootWalletTokenInventoryService';
import type { QuantumrootUiState, QuantumrootLaneState } from './quantumrootTypes';

function normalizeCategory(category: string | null | undefined) {
  return (category ?? '').trim().replace(/^0x/i, '').toLowerCase();
}

function buildNextRequiredAction(
  laneState: QuantumrootLaneState,
  spendableCoinCount: number,
  hasSpendDestination: boolean,
  isActiveNetwork: boolean
): QuantumrootUiState['nextRequiredAction'] {
  switch (laneState) {
    case 'no-family':
      return {
        kind: 'open-cashtokens',
        title: 'Create an approval key',
        label: 'Open CashTokens',
        description: 'Create or receive a plain NFT first, then use it as the approval key.',
        tone: 'warning',
        enabled: true,
      };
    case 'pick-family':
      return {
        kind: 'pick-family',
        title: 'Choose an approval key',
        label: 'Choose approval key',
        description: 'Choose one approval key for this vault.',
        tone: 'warning',
        enabled: true,
      };
    case 'stale-inventory':
      return {
        kind: 'refresh-vault',
        title: 'Refresh the vault',
        label: 'Refresh vault',
        description: 'Refresh the wallet scan or choose another approval key.',
        tone: 'warning',
        enabled: true,
      };
    case 'approval-pending':
      return {
        kind: 'send-approval-token',
        title: 'Send the approval key',
        label: 'Send approval key',
        description: 'Send the approval key to Quantum Lock.',
        tone: 'warning',
        enabled: true,
      };
    case 'receive-pending':
      return {
        kind: 'fund-receive-coin',
        title: 'Add the matching receive coin',
        label: 'Add receive coin',
        description: 'Send the matching receive coin to the normal lane.',
        tone: 'warning',
        enabled: true,
      };
    case 'ready':
    default:
      if (!hasSpendDestination) {
        return {
          kind: 'set-destination',
          title: 'Choose a destination',
          label: 'Set destination',
          description: 'Choose where the coin should go, then open the spend list.',
          tone: 'warning',
          enabled: true,
        };
      }

      if (!isActiveNetwork) {
        return {
          kind: 'open-spend-list',
          title: 'Ready to spend',
          label: spendableCoinCount > 1 ? 'Choose coin to spend' : 'Review spend',
          description: 'The spend list is ready, but spending is disabled on this network.',
          tone: 'warning',
          enabled: false,
        };
      }

      return {
        kind: 'open-spend-list',
        title: 'Ready to spend',
        label: spendableCoinCount > 1 ? 'Choose coin to spend' : 'Review spend',
        description: 'Tap a ready coin to spend it.',
        tone: 'success',
        enabled: true,
      };
  }
}

export type QuantumrootUiStateInput = {
  plainNftFamilies: QuantumrootWalletTokenSummary[];
  pendingTokenCategory: string;
  pendingSpendAddress: string;
  selectedVaultTokenAwareness: QuantumrootTokenAwareness | null;
  isActiveNetwork: boolean;
};

export function deriveQuantumrootUiState({
  plainNftFamilies,
  pendingTokenCategory,
  pendingSpendAddress,
  selectedVaultTokenAwareness,
  isActiveNetwork,
}: QuantumrootUiStateInput): QuantumrootUiState {
  const normalizedPendingCategory = normalizeCategory(pendingTokenCategory);
  const familyCount = plainNftFamilies.length;
  const selectedFamilySummary = plainNftFamilies.find(
    (family) => normalizeCategory(family.category) === normalizedPendingCategory
  ) ?? null;
  const approvalTokenCount = selectedVaultTokenAwareness?.matchingControlTokenUtxos.length ?? 0;
  const receiveTokenCount = selectedVaultTokenAwareness?.matchingReceiveTokenUtxos.length ?? 0;
  const unrelatedQuantumLockTokenCount =
    selectedVaultTokenAwareness?.unrelatedQuantumLockTokenUtxos.length ?? 0;
  const hasMismatchedQuantumLockToken = unrelatedQuantumLockTokenCount > 0;
  const hasConfiguredTokenCategory = isConfiguredQuantumrootTokenCategory(
    pendingTokenCategory
  );
  const isStaleInventory =
    hasConfiguredTokenCategory && familyCount > 0 && selectedFamilySummary === null;
  const laneState: QuantumrootLaneState = (() => {
    if (familyCount === 0) return 'no-family';
    if (!hasConfiguredTokenCategory) return 'pick-family';
    if (isStaleInventory) return 'stale-inventory';
    if (approvalTokenCount === 0) return 'approval-pending';
    if (receiveTokenCount === 0) return 'receive-pending';
    return 'ready';
  })();
  const hasSpendDestination = pendingSpendAddress.trim().length > 0;
  const canAuthorizedSpend =
    laneState === 'ready' && hasSpendDestination && isActiveNetwork;
  const blockingReason =
    laneState === 'no-family'
      ? 'Create or receive a plain NFT first. It becomes your approval key.'
      : laneState === 'pick-family'
        ? 'Choose one plain NFT to use as the approval key.'
        : laneState === 'stale-inventory'
          ? 'Your selected approval key is not visible right now. Refresh the vault or choose another key.'
          : laneState === 'approval-pending'
            ? 'Send one approval key to Quantum Lock.'
            : laneState === 'receive-pending'
              ? 'Send the matching receive coin to the normal lane.'
              : !hasSpendDestination
                ? 'Choose a destination address before spending.'
                : !isActiveNetwork
                  ? 'Quantumroot spending is disabled on this network.'
                  : null;

  return {
    laneState,
    nextRequiredAction: buildNextRequiredAction(
      laneState,
      receiveTokenCount,
      hasSpendDestination,
      isActiveNetwork
    ),
    blockingReason,
    hasMismatchedQuantumLockToken,
    canAuthorizedSpend,
    isStaleInventory,
    selectedFamilySummary,
    familyCount,
    approvalTokenCount,
    receiveTokenCount,
    unrelatedQuantumLockTokenCount,
    hasSpendDestination,
  };
}
