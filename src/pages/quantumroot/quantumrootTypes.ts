import type { QuantumrootTokenAwareness } from '../../services/QuantumrootTokenAwarenessService';
import type { QuantumrootWalletTokenSummary } from '../../services/QuantumrootWalletTokenInventoryService';
import type { QuantumrootVaultStatus } from '../../services/QuantumrootVaultStatusService';
import type { QuantumrootVaultRecord, UTXO } from '../../types/types';

export type QuantumrootSendFlow = 'approval-token' | 'receive-coin';

export type QuantumrootLaneState =
  | 'no-family'
  | 'pick-family'
  | 'approval-pending'
  | 'receive-pending'
  | 'ready'
  | 'stale-inventory';

export type QuantumrootNextRequiredActionKind =
  | 'open-cashtokens'
  | 'pick-family'
  | 'send-approval-token'
  | 'fund-receive-coin'
  | 'set-destination'
  | 'open-spend-list'
  | 'refresh-vault';

export type QuantumrootNextRequiredAction = {
  kind: QuantumrootNextRequiredActionKind;
  title: string;
  label: string;
  description: string;
  tone: 'success' | 'warning' | 'neutral';
  enabled: boolean;
};

export type QuantumrootUiState = {
  laneState: QuantumrootLaneState;
  nextRequiredAction: QuantumrootNextRequiredAction;
  blockingReason: string | null;
  hasMismatchedQuantumLockToken: boolean;
  canAuthorizedSpend: boolean;
  isStaleInventory: boolean;
  selectedFamilySummary: QuantumrootWalletTokenSummary | null;
  familyCount: number;
  approvalTokenCount: number;
  receiveTokenCount: number;
  unrelatedQuantumLockTokenCount: number;
  hasSpendDestination: boolean;
};

export type VaultStatusView = QuantumrootVaultStatus & {
  recoverableReceiveUtxos: UTXO[];
  unsupportedReceiveUtxos: UTXO[];
  recoverableQuantumLockUtxos: UTXO[];
  unsupportedQuantumLockUtxos: UTXO[];
};

export type WalletKey = {
  address: string;
  addressIndex: number;
  changeIndex?: number;
};

export type QuantumrootWorkspaceState = {
  vaults: QuantumrootVaultRecord[];
  walletKeys: WalletKey[];
  walletTokenInventory: QuantumrootWalletTokenSummary[];
  quantumrootPlainNftFamilies: QuantumrootWalletTokenSummary[];
  quantumrootUiState: QuantumrootUiState;
  statusesByIndex: Record<number, VaultStatusView>;
  tokenAwarenessByIndex: Record<number, QuantumrootTokenAwareness>;
  loading: boolean;
  refreshing: boolean;
  loadError: string | null;
  syncing: boolean;
  selectedVault: QuantumrootVaultRecord | null;
  recoveringOutpoint: string | null;
  sweepingAll: boolean;
  pendingSpendAddress: string;
  pendingTokenCategory: string;
  savingConfiguration: boolean;
};
