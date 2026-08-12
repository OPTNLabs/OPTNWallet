import type { QuantumrootTokenAwareness } from '../../services/QuantumrootTokenAwarenessService';
import type { QuantumrootVaultStatus } from '../../services/QuantumrootVaultStatusService';
import type { QuantumrootVaultRecord, UTXO } from '../../types/types';

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
  statusesByIndex: Record<number, VaultStatusView>;
  tokenAwarenessByIndex: Record<number, QuantumrootTokenAwareness>;
  loading: boolean;
  syncing: boolean;
  selectedVault: QuantumrootVaultRecord | null;
  recoveringOutpoint: string | null;
  sweepingAll: boolean;
  pendingSpendAddress: string;
  pendingTokenCategory: string;
  savingConfiguration: boolean;
};
