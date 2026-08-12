import { describe, expect, it } from 'vitest';

import type { QuantumrootTokenAwareness } from '../../../services/QuantumrootTokenAwarenessService';
import type { QuantumrootWalletTokenSummary } from '../../../services/QuantumrootWalletTokenInventoryService';
import type { UTXO } from '../../../types/types';
import { deriveQuantumrootUiState } from '../quantumrootUiState';

function makeFamily(category: string, plainNftUtxoCount = 1): QuantumrootWalletTokenSummary {
  return {
    category,
    totalAtomicAmount: BigInt(plainNftUtxoCount * 1000),
    tokenUtxoCount: plainNftUtxoCount,
    fungibleUtxoCount: 0,
    nftUtxoCount: plainNftUtxoCount,
    plainNftUtxoCount,
    mutableNftUtxoCount: 0,
    mintingNftUtxoCount: 0,
    capabilities: ['none'],
  };
}

function makeUtxo(category: string, txPos: number): UTXO {
  return {
    address: 'bchtest:test',
    value: 546,
    amount: 546,
    height: 0,
    tx_hash: `tx-${category.slice(0, 6)}-${txPos}`,
    tx_pos: txPos,
    token: {
      category,
      amount: 1,
      nft: {
        capability: 'none',
        commitment: '',
      },
    },
  };
}

function makeAwareness({
  category,
  controlCount = 0,
  receiveCount = 0,
  unrelatedCount = 0,
}: {
  category: string;
  controlCount?: number;
  receiveCount?: number;
  unrelatedCount?: number;
}): QuantumrootTokenAwareness {
  const matchingControlTokenUtxos = Array.from({ length: controlCount }, (_, index) =>
    makeUtxo(category, index)
  );
  const matchingReceiveTokenUtxos = Array.from({ length: receiveCount }, (_, index) =>
    makeUtxo(category, index + 10)
  );
  const unrelatedQuantumLockTokenUtxos = Array.from(
    { length: unrelatedCount },
    (_, index) => makeUtxo('ff'.repeat(32), index + 20)
  );

    return {
      configuredTokenCategory: category,
      hasConfiguredTokenCategory: true,
      matchingControlTokenUtxos,
      matchingReceiveTokenUtxos,
      unrelatedQuantumLockTokenUtxos,
      tokenizedReceiveUtxos: matchingReceiveTokenUtxos,
      canAuthorizedSpend: controlCount > 0 && receiveCount > 0,
      readinessLabel:
        controlCount === 0
          ? 'Waiting for the approval key'
          : receiveCount === 0
            ? 'Waiting for the matching receive coin'
            : 'Ready to spend',
    };
  }

describe('deriveQuantumrootUiState', () => {
  const familyCategory = '11'.repeat(32);
  const otherCategory = '22'.repeat(32);

  it('prompts the user to open CashTokens when no approval keys exist', () => {
    const uiState = deriveQuantumrootUiState({
      plainNftFamilies: [],
      pendingTokenCategory: '',
      pendingSpendAddress: '',
      selectedVaultTokenAwareness: null,
      isActiveNetwork: true,
    });

    expect(uiState.laneState).toBe('no-family');
    expect(uiState.nextRequiredAction.kind).toBe('open-cashtokens');
    expect(uiState.nextRequiredAction.title).toBe('Create an approval key');
    expect(uiState.canAuthorizedSpend).toBe(false);
    expect(uiState.blockingReason).toContain('approval key');
  });

  it('asks the user to pick an approval key when keys exist but none are selected', () => {
    const uiState = deriveQuantumrootUiState({
      plainNftFamilies: [makeFamily(familyCategory)],
      pendingTokenCategory: '',
      pendingSpendAddress: '',
      selectedVaultTokenAwareness: null,
      isActiveNetwork: true,
    });

    expect(uiState.laneState).toBe('pick-family');
    expect(uiState.nextRequiredAction.kind).toBe('pick-family');
    expect(uiState.selectedFamilySummary).toBeNull();
    expect(uiState.familyCount).toBe(1);
  });

  it('flags stale inventory when the selected category is no longer visible', () => {
    const uiState = deriveQuantumrootUiState({
      plainNftFamilies: [makeFamily(otherCategory)],
      pendingTokenCategory: familyCategory,
      pendingSpendAddress: '',
      selectedVaultTokenAwareness: null,
      isActiveNetwork: true,
    });

    expect(uiState.laneState).toBe('stale-inventory');
    expect(uiState.isStaleInventory).toBe(true);
    expect(uiState.nextRequiredAction.kind).toBe('refresh-vault');
    expect(uiState.selectedFamilySummary).toBeNull();
  });

  it('waits for the approval key before allowing authorized spend', () => {
    const uiState = deriveQuantumrootUiState({
      plainNftFamilies: [makeFamily(familyCategory)],
      pendingTokenCategory: familyCategory,
      pendingSpendAddress: '',
      selectedVaultTokenAwareness: makeAwareness({
        category: familyCategory,
        controlCount: 0,
        receiveCount: 1,
      }),
      isActiveNetwork: true,
    });

    expect(uiState.laneState).toBe('approval-pending');
    expect(uiState.nextRequiredAction.kind).toBe('send-approval-token');
    expect(uiState.nextRequiredAction.label).toBe('Send approval key');
    expect(uiState.canAuthorizedSpend).toBe(false);
  });

  it('waits for the matching receive coin after the approval key is present', () => {
    const uiState = deriveQuantumrootUiState({
      plainNftFamilies: [makeFamily(familyCategory)],
      pendingTokenCategory: familyCategory,
      pendingSpendAddress: '',
      selectedVaultTokenAwareness: makeAwareness({
        category: familyCategory,
        controlCount: 1,
        receiveCount: 0,
      }),
      isActiveNetwork: true,
    });

    expect(uiState.laneState).toBe('receive-pending');
    expect(uiState.nextRequiredAction.kind).toBe('fund-receive-coin');
    expect(uiState.nextRequiredAction.label).toBe('Add receive coin');
    expect(uiState.canAuthorizedSpend).toBe(false);
  });

  it('requires a spend destination before enabling the spend lane', () => {
    const uiState = deriveQuantumrootUiState({
      plainNftFamilies: [makeFamily(familyCategory)],
      pendingTokenCategory: familyCategory,
      pendingSpendAddress: '',
      selectedVaultTokenAwareness: makeAwareness({
        category: familyCategory,
        controlCount: 1,
        receiveCount: 1,
      }),
      isActiveNetwork: true,
    });

    expect(uiState.laneState).toBe('ready');
    expect(uiState.nextRequiredAction.kind).toBe('set-destination');
    expect(uiState.canAuthorizedSpend).toBe(false);
  });

  it('enables spending only when the lane is ready, destination is set, and the network is active', () => {
    const uiState = deriveQuantumrootUiState({
      plainNftFamilies: [makeFamily(familyCategory)],
      pendingTokenCategory: familyCategory,
      pendingSpendAddress: 'bchtest:destination',
      selectedVaultTokenAwareness: makeAwareness({
        category: familyCategory,
        controlCount: 1,
        receiveCount: 1,
        unrelatedCount: 1,
      }),
      isActiveNetwork: true,
    });

    expect(uiState.laneState).toBe('ready');
    expect(uiState.nextRequiredAction.kind).toBe('open-spend-list');
    expect(uiState.nextRequiredAction.enabled).toBe(true);
    expect(uiState.canAuthorizedSpend).toBe(true);
    expect(uiState.hasMismatchedQuantumLockToken).toBe(true);
    expect(uiState.unrelatedQuantumLockTokenCount).toBe(1);
  });

  it('blocks spending on inactive networks even when all other requirements are met', () => {
    const uiState = deriveQuantumrootUiState({
      plainNftFamilies: [makeFamily(familyCategory)],
      pendingTokenCategory: familyCategory,
      pendingSpendAddress: 'bchtest:destination',
      selectedVaultTokenAwareness: makeAwareness({
        category: familyCategory,
        controlCount: 1,
        receiveCount: 1,
      }),
      isActiveNetwork: false,
    });

    expect(uiState.laneState).toBe('ready');
    expect(uiState.nextRequiredAction.kind).toBe('open-spend-list');
    expect(uiState.nextRequiredAction.enabled).toBe(false);
    expect(uiState.canAuthorizedSpend).toBe(false);
  });
});
