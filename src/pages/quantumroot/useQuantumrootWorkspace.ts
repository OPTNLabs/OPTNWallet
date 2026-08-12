import { useCallback, useEffect, useMemo, useState } from 'react';
import { Toast } from '@capacitor/toast';

import KeyService from '../../services/KeyService';
import UTXOService from '../../services/UTXOService';
import {
  bucketQuantumrootReceiveUtxos,
  summarizeQuantumrootVaultStatus,
} from '../../services/QuantumrootVaultStatusService';
import {
  summarizeQuantumrootTokenAwareness,
  type QuantumrootTokenAwareness,
} from '../../services/QuantumrootTokenAwarenessService';
import { shortenTxHash } from '../../utils/shortenHash';
import TransactionService from '../../services/TransactionService';
import {
  buildQuantumrootAggregateRecoverySweepTransaction,
  buildQuantumrootQuantumLockRecoveryTransaction,
  buildQuantumrootRecoveryTransaction,
} from '../../services/QuantumrootRecoveryService';
import { zeroizeQuantumrootArtifacts } from '../../services/QuantumrootService';
import type { QuantumrootVaultRecord, UTXO } from '../../types/types';
import type {
  QuantumrootWorkspaceState,
  VaultStatusView,
  WalletKey,
} from './quantumrootTypes';

type UseQuantumrootWorkspaceArgs = {
  currentWalletId: number | null;
};

type UseQuantumrootWorkspaceResult = QuantumrootWorkspaceState & {
  portfolio: {
    totalBalanceSats: number;
    recoverableUtxos: number;
    unsupportedReceiveUtxos: number;
    fundedVaults: number;
  };
  selectedVaultStatus: VaultStatusView | null;
  selectedVaultTokenAwareness: QuantumrootTokenAwareness | null;
  recoveryDestinationAddress: string | null;
  loadQuantumrootWorkspace: () => Promise<void>;
  handleSyncVaults: () => Promise<void>;
  handleSaveVaultConfiguration: () => Promise<void>;
  handleSpendUtxo: (utxo: UTXO, destinationAddress: string) => Promise<void>;
  handleSweepAllReceiveUtxos: () => Promise<void>;
  handleRecoverQuantumLockUtxo: (
    utxo: UTXO,
    destinationAddress: string
  ) => Promise<void>;
  setSelectedVault: (vault: QuantumrootVaultRecord | null) => void;
  setPendingSpendAddress: (value: string) => void;
  setPendingTokenCategory: (value: string) => void;
};

export function useQuantumrootWorkspace({
  currentWalletId,
}: UseQuantumrootWorkspaceArgs): UseQuantumrootWorkspaceResult {
  const [vaults, setVaults] = useState<QuantumrootVaultRecord[]>([]);
  const [walletKeys, setWalletKeys] = useState<WalletKey[]>([]);
  const [statusesByIndex, setStatusesByIndex] = useState<
    Record<number, VaultStatusView>
  >({});
  const [tokenAwarenessByIndex, setTokenAwarenessByIndex] = useState<
    Record<number, QuantumrootTokenAwareness>
  >({});
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [selectedVault, setSelectedVault] = useState<QuantumrootVaultRecord | null>(
    null
  );
  const [recoveringOutpoint, setRecoveringOutpoint] = useState<string | null>(null);
  const [sweepingAll, setSweepingAll] = useState(false);
  const [pendingSpendAddress, setPendingSpendAddress] = useState('');
  const [pendingTokenCategory, setPendingTokenCategory] = useState('');
  const [savingConfiguration, setSavingConfiguration] = useState(false);

  const loadQuantumrootWorkspace = useCallback(async () => {
    if (!currentWalletId) return;

    setLoading(true);
    try {
      const keys = (await KeyService.retrieveKeys(currentWalletId)) as WalletKey[];
      setWalletKeys(keys);

      const nextVaults = await KeyService.retrieveQuantumrootVaults(currentWalletId);
      setVaults(nextVaults);

      const allAddresses = Array.from(
        new Set(
          nextVaults.flatMap((vault) => [
            vault.receive_address,
            vault.quantum_lock_address,
          ])
        )
      ).filter(Boolean);

      const utxosByAddress =
        allAddresses.length > 0
          ? await UTXOService.fetchAndStoreUTXOsMany(currentWalletId, allAddresses)
          : {};

      const nextStatuses = Object.fromEntries(
        nextVaults.map((vault) => {
          const receiveUtxos = utxosByAddress[vault.receive_address] ?? [];
          const quantumLockUtxos = utxosByAddress[vault.quantum_lock_address] ?? [];
          const receiveBuckets = bucketQuantumrootReceiveUtxos(receiveUtxos);
          const quantumLockBuckets = bucketQuantumrootReceiveUtxos(quantumLockUtxos);
          return [
            vault.address_index,
            {
              ...summarizeQuantumrootVaultStatus(receiveUtxos, quantumLockUtxos),
              ...receiveBuckets,
              recoverableQuantumLockUtxos: quantumLockBuckets.recoverableReceiveUtxos,
              unsupportedQuantumLockUtxos: quantumLockBuckets.unsupportedReceiveUtxos,
            },
          ];
        })
      ) as Record<number, VaultStatusView>;

      setStatusesByIndex(nextStatuses);
      setTokenAwarenessByIndex(
        Object.fromEntries(
          nextVaults.map((vault) => {
            const receiveUtxos = utxosByAddress[vault.receive_address] ?? [];
            const quantumLockUtxos = utxosByAddress[vault.quantum_lock_address] ?? [];
            return [
              vault.address_index,
              summarizeQuantumrootTokenAwareness(
                vault,
                receiveUtxos,
                quantumLockUtxos
              ),
            ];
          })
        ) as Record<number, QuantumrootTokenAwareness>
      );
    } finally {
      setLoading(false);
    }
  }, [currentWalletId]);

  useEffect(() => {
    void loadQuantumrootWorkspace();
  }, [loadQuantumrootWorkspace]);

  const handleSyncVaults = useCallback(async () => {
    if (!currentWalletId) return;

    setSyncing(true);
    try {
      const keys = await KeyService.retrieveKeys(currentWalletId);
      const uniqueAddressIndexes = Array.from(
        new Set(
          (keys ?? [])
            .map((key) => key.addressIndex)
            .filter((value): value is number => typeof value === 'number')
        )
      ).sort((a, b) => a - b);

      await Promise.all(
        uniqueAddressIndexes.map((addressIndex) =>
          KeyService.createQuantumrootVault(currentWalletId, addressIndex, 0)
        )
      );

      await loadQuantumrootWorkspace();
    } finally {
      setSyncing(false);
    }
  }, [currentWalletId, loadQuantumrootWorkspace]);

  const portfolio = useMemo(() => {
    const statuses = Object.values(statusesByIndex);
    return {
      totalBalanceSats: statuses.reduce((sum, status) => sum + status.totalBalanceSats, 0),
      recoverableUtxos: statuses.reduce(
        (sum, status) => sum + status.recoverableReceiveUtxos.length,
        0
      ),
      unsupportedReceiveUtxos: statuses.reduce(
        (sum, status) => sum + status.unsupportedReceiveUtxos.length,
        0
      ),
      fundedVaults: statuses.filter((status) => status.isFunded).length,
    };
  }, [statusesByIndex]);

  const selectedVaultStatus = selectedVault
    ? statusesByIndex[selectedVault.address_index]
    : null;
  const selectedVaultTokenAwareness = selectedVault
    ? tokenAwarenessByIndex[selectedVault.address_index]
    : null;

  const recoveryDestinationAddress = useMemo(() => {
    if (!selectedVault) return null;

    const matchingMainKey = walletKeys.find(
      (key) =>
        key.addressIndex === selectedVault.address_index &&
        (key.changeIndex === undefined || key.changeIndex === 0)
    );
    if (matchingMainKey?.address) return matchingMainKey.address;

    const firstMainKey = walletKeys.find(
      (key) => key.changeIndex === undefined || key.changeIndex === 0
    );
    return firstMainKey?.address ?? null;
  }, [selectedVault, walletKeys]);

  useEffect(() => {
    setPendingTokenCategory(selectedVault?.vault_token_category ?? '');
    setPendingSpendAddress(recoveryDestinationAddress ?? '');
  }, [recoveryDestinationAddress, selectedVault]);

  const handleSaveVaultConfiguration = useCallback(async () => {
    if (!currentWalletId || !selectedVault) return;

    const normalized = pendingTokenCategory.trim().replace(/^0x/i, '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(normalized)) {
      await Toast.show({ text: 'Token category must be 64 hex characters.' });
      return;
    }

    setSavingConfiguration(true);
    try {
      const updated = await KeyService.configureQuantumrootVault(
        currentWalletId,
        selectedVault.address_index,
        selectedVault.account_index,
        selectedVault.online_quantum_signer,
        normalized
      );
      await loadQuantumrootWorkspace();
      setSelectedVault(updated);
      setPendingTokenCategory(updated.vault_token_category);
      await Toast.show({ text: 'Quantumroot vault reconfigured.' });
    } catch (error) {
      console.error('Failed to configure Quantumroot vault:', error);
      await Toast.show({
        text: `Failed to configure vault: ${(error as Error).message}`,
      });
    } finally {
      setSavingConfiguration(false);
    }
  }, [currentWalletId, loadQuantumrootWorkspace, pendingTokenCategory, selectedVault]);

  const handleSpendUtxo = useCallback(
    async (utxo: UTXO, destinationAddress: string) => {
      if (!currentWalletId || !selectedVault) {
        await Toast.show({ text: 'Quantumroot vault unavailable.' });
        return;
      }

      const normalizedDestination = destinationAddress.trim();
      if (!normalizedDestination) {
        await Toast.show({ text: 'Destination address is required.' });
        return;
      }

      const outpointKey = `${utxo.tx_hash}:${utxo.tx_pos}`;
      setRecoveringOutpoint(outpointKey);

      try {
        const vault = await KeyService.deriveQuantumrootVault(
          currentWalletId,
          selectedVault.address_index,
          selectedVault.account_index,
          selectedVault.online_quantum_signer === 1 ? '1' : '0',
          selectedVault.vault_token_category
        );

        try {
          const built = buildQuantumrootRecoveryTransaction({
            destinationAddress: normalizedDestination,
            utxo,
            vault,
            vaultTokenCategory: selectedVault.vault_token_category,
          });

          const sent = await TransactionService.sendTransaction(
            built.rawTransaction,
            [utxo],
            {
              source: 'quantumroot-spend',
              sourceLabel: 'Quantumroot Spend',
              recipientSummary: normalizedDestination,
              amountSummary: built.recoveryAmountSats.toString(),
              userPrompt: 'Spend BCH from a Quantumroot receive address',
            }
          );

          if (!sent.txid) {
            throw new Error(sent.errorMessage || 'Failed to broadcast Quantumroot spend.');
          }

          await Toast.show({
            text: `Quantumroot spend broadcast: ${shortenTxHash(sent.txid)}`,
          });
          await loadQuantumrootWorkspace();
        } finally {
          zeroizeQuantumrootArtifacts(vault);
        }
      } catch (error) {
        console.error('Quantumroot spend failed from workspace:', error);
        await Toast.show({
          text: `Quantumroot spend failed: ${(error as Error).message}`,
        });
      } finally {
        setRecoveringOutpoint(null);
      }
    },
    [currentWalletId, loadQuantumrootWorkspace, selectedVault]
  );

  const handleSweepAllReceiveUtxos = useCallback(async () => {
    if (!currentWalletId || !selectedVault || !selectedVaultStatus) {
      await Toast.show({ text: 'Quantumroot vault unavailable.' });
      return;
    }

    const normalizedDestination = pendingSpendAddress.trim();
    if (!normalizedDestination) {
      await Toast.show({ text: 'Destination address is required.' });
      return;
    }

    if (selectedVaultStatus.recoverableReceiveUtxos.length === 0) {
      await Toast.show({ text: 'No BCH-only receive UTXOs available to sweep.' });
      return;
    }

    setSweepingAll(true);
    try {
      const vault = await KeyService.deriveQuantumrootVault(
        currentWalletId,
        selectedVault.address_index,
        selectedVault.account_index,
        selectedVault.online_quantum_signer === 1 ? '1' : '0',
        selectedVault.vault_token_category
      );

      try {
        const aggregateSweep = buildQuantumrootAggregateRecoverySweepTransaction({
          destinationAddress: normalizedDestination,
          utxos: selectedVaultStatus.recoverableReceiveUtxos,
          vault,
          vaultTokenCategory: selectedVault.vault_token_category,
        });

        const sent = await TransactionService.sendTransaction(
          aggregateSweep.rawTransaction,
          aggregateSweep.sweptUtxos,
          {
            source: 'quantumroot-sweep',
            sourceLabel: 'Quantumroot Sweep',
            recipientSummary: normalizedDestination,
            amountSummary: aggregateSweep.recoveryAmountSats.toString(),
            userPrompt: 'Sweep BCH from Quantumroot receive UTXOs',
          }
        );
        if (!sent.txid) {
          throw new Error(sent.errorMessage || 'Failed to broadcast Quantumroot sweep.');
        }

        await Toast.show({
          text: `Quantumroot sweep broadcast: ${shortenTxHash(sent.txid)}`,
        });
        await loadQuantumrootWorkspace();
      } finally {
        zeroizeQuantumrootArtifacts(vault);
      }
    } catch (error) {
      console.error('Quantumroot sweep failed from workspace:', error);
      await Toast.show({
        text: `Quantumroot sweep failed: ${(error as Error).message}`,
      });
    } finally {
      setSweepingAll(false);
    }
  }, [
    currentWalletId,
    loadQuantumrootWorkspace,
    pendingSpendAddress,
    selectedVault,
    selectedVaultStatus,
  ]);

  const handleRecoverQuantumLockUtxo = useCallback(
    async (utxo: UTXO, destinationAddress: string) => {
      if (!currentWalletId || !selectedVault) {
        await Toast.show({ text: 'Quantumroot vault unavailable.' });
        return;
      }

      const normalizedDestination = destinationAddress.trim();
      if (!normalizedDestination) {
        await Toast.show({ text: 'Destination address is required.' });
        return;
      }

      const outpointKey = `${utxo.tx_hash}:${utxo.tx_pos}`;
      setRecoveringOutpoint(outpointKey);

      try {
        const vault = await KeyService.deriveQuantumrootVault(
          currentWalletId,
          selectedVault.address_index,
          selectedVault.account_index,
          selectedVault.online_quantum_signer === 1 ? '1' : '0',
          selectedVault.vault_token_category
        );

        try {
          const built = buildQuantumrootQuantumLockRecoveryTransaction({
            destinationAddress: normalizedDestination,
            utxo,
            vault,
            vaultTokenCategory: selectedVault.vault_token_category,
          });

          const sent = await TransactionService.sendTransaction(
            built.rawTransaction,
            [utxo],
            {
              source: 'quantumroot-quantum-lock-recovery',
              sourceLabel: 'Quantum Lock Recovery',
              recipientSummary: normalizedDestination,
              amountSummary: built.recoveryAmountSats.toString(),
              userPrompt: 'Recover BCH from a Quantumroot Quantum Lock UTXO',
            }
          );

          if (!sent.txid) {
            throw new Error(
              sent.errorMessage || 'Failed to broadcast Quantum Lock recovery.'
            );
          }

          await Toast.show({
            text: `Quantum Lock recovery broadcast: ${shortenTxHash(sent.txid)}`,
          });
          await loadQuantumrootWorkspace();
        } finally {
          zeroizeQuantumrootArtifacts(vault);
        }
      } catch (error) {
        console.error('Quantum Lock recovery failed from workspace:', error);
        await Toast.show({
          text: `Quantum Lock recovery failed: ${(error as Error).message}`,
        });
      } finally {
        setRecoveringOutpoint(null);
      }
    },
    [currentWalletId, loadQuantumrootWorkspace, selectedVault]
  );

  return {
    vaults,
    walletKeys,
    statusesByIndex,
    tokenAwarenessByIndex,
    loading,
    syncing,
    selectedVault,
    recoveringOutpoint,
    sweepingAll,
    pendingSpendAddress,
    pendingTokenCategory,
    savingConfiguration,
    portfolio,
    selectedVaultStatus,
    selectedVaultTokenAwareness,
    recoveryDestinationAddress,
    loadQuantumrootWorkspace,
    handleSyncVaults,
    handleSaveVaultConfiguration,
    handleSpendUtxo,
    handleSweepAllReceiveUtxos,
    handleRecoverQuantumLockUtxo,
    setSelectedVault,
    setPendingSpendAddress,
    setPendingTokenCategory,
  };
}
