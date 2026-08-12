import { useCallback, useEffect, useMemo, useState } from 'react';
import { Toast } from '@capacitor/toast';

import KeyService from '../../services/KeyService';
import UTXOService from '../../services/UTXOService';
import {
  summarizeQuantumrootWalletTokenInventory,
  type QuantumrootWalletTokenSummary,
} from '../../services/QuantumrootWalletTokenInventoryService';
import {
  bucketQuantumrootReceiveUtxos,
  summarizeQuantumrootVaultStatus,
} from '../../services/QuantumrootVaultStatusService';
import {
  summarizeQuantumrootTokenAwareness,
  type QuantumrootTokenAwareness,
} from '../../services/QuantumrootTokenAwarenessService';
import { validateQuantumrootAuthorizedSpendAgainstFulcrum } from '../../services/QuantumrootFulcrumValidationService';
import { shortenTxHash } from '../../utils/shortenHash';
import TransactionService from '../../services/TransactionService';
import {
  buildQuantumrootAuthorizedSpendTransaction,
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
import { deriveQuantumrootUiState } from './quantumrootUiState';

function describeQuantumrootError(error: unknown) {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'Unknown Quantumroot error.';

  if (message.includes('fall below dust after fees')) {
    return 'That coin is too small to spend after fees. Try a larger receive coin.';
  }
  if (message.includes('control token UTXO is not currently visible')) {
    return 'Refresh the vault. The approval key is no longer visible on the chain.';
  }
  if (message.includes('control token category does not match')) {
    return 'Refresh the vault. The selected approval key no longer matches the chain state.';
  }
  if (message.includes('destination output does not match the requested destination address')) {
    return 'Check the destination address and try again.';
  }
  if (message.includes('Quantumroot authorized spend requires a matching control token category')) {
    return 'The approval key does not match the selected key. Refresh and choose the correct one.';
  }

  return message;
}

type UseQuantumrootWorkspaceArgs = {
  currentWalletId: number | null;
  workspaceEnabled?: boolean;
  isActiveNetwork?: boolean;
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
  walletTokenInventory: QuantumrootWalletTokenSummary[];
  recoveryDestinationAddress: string | null;
  loadQuantumrootWorkspace: () => Promise<void>;
  handleSyncVaults: () => Promise<void>;
  handleSaveVaultConfiguration: () => Promise<void>;
  handleSpendUtxo: (utxo: UTXO, destinationAddress: string) => Promise<void>;
  handleAuthorizedSpendUtxo: (
    utxo: UTXO,
    destinationAddress: string
  ) => Promise<void>;
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
  workspaceEnabled = true,
  isActiveNetwork = true,
}: UseQuantumrootWorkspaceArgs): UseQuantumrootWorkspaceResult {
  const [vaults, setVaults] = useState<QuantumrootVaultRecord[]>([]);
  const [walletKeys, setWalletKeys] = useState<WalletKey[]>([]);
  const [walletTokenInventory, setWalletTokenInventory] = useState<
    QuantumrootWalletTokenSummary[]
  >([]);
  const [statusesByIndex, setStatusesByIndex] = useState<
    Record<number, VaultStatusView>
  >({});
  const [tokenAwarenessByIndex, setTokenAwarenessByIndex] = useState<
    Record<number, QuantumrootTokenAwareness>
  >({});
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
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
    if (!currentWalletId || !workspaceEnabled) {
      setLoading(false);
      setRefreshing(false);
      setLoadError(null);
      setVaults([]);
      setWalletKeys([]);
      setWalletTokenInventory([]);
      setStatusesByIndex({});
      setTokenAwarenessByIndex({});
      return;
    }

    setLoading(true);
    setLoadError(null);
    try {
      const keys = (await KeyService.retrieveKeys(currentWalletId)) as WalletKey[];
      setWalletKeys(keys);

      const nextVaults = await KeyService.retrieveQuantumrootVaults(currentWalletId);
      setVaults(nextVaults);
      setLoading(false);

      const allAddresses = Array.from(
        new Set([
          ...keys.map((key) => key.address),
          ...nextVaults.flatMap((vault) => [
            vault.receive_address,
            vault.quantum_lock_address,
          ]),
        ])
      ).filter(Boolean);

      setRefreshing(true);
      const utxosByAddress =
        allAddresses.length > 0
          ? await UTXOService.fetchAndStoreUTXOsMany(currentWalletId, allAddresses)
          : {};
      setWalletTokenInventory(
        summarizeQuantumrootWalletTokenInventory(Object.values(utxosByAddress).flat())
      );

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
    } catch (error) {
      console.error('Failed to load Quantumroot workspace:', error);
      setLoadError((error as Error).message || 'Quantumroot workspace failed to load.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [currentWalletId, workspaceEnabled]);

  useEffect(() => {
    void loadQuantumrootWorkspace();
  }, [loadQuantumrootWorkspace]);

  const handleSyncVaults = useCallback(async () => {
    if (!currentWalletId || !workspaceEnabled) {
      await Toast.show({
        text: 'Quantumroot mainnet preview is active until activation.',
      });
      return;
    }

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
  }, [currentWalletId, loadQuantumrootWorkspace, workspaceEnabled]);

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

  const quantumrootPlainNftFamilies = useMemo(
    () => walletTokenInventory.filter((token) => token.plainNftUtxoCount > 0),
    [walletTokenInventory]
  );

  const quantumrootUiState = useMemo(
    () =>
      deriveQuantumrootUiState({
        plainNftFamilies: quantumrootPlainNftFamilies,
        pendingTokenCategory,
        pendingSpendAddress,
        selectedVaultTokenAwareness,
        isActiveNetwork,
      }),
    [
      isActiveNetwork,
      pendingSpendAddress,
      pendingTokenCategory,
      quantumrootPlainNftFamilies,
      selectedVaultTokenAwareness,
    ]
  );

  const handleSaveVaultConfiguration = useCallback(async () => {
    if (!currentWalletId || !selectedVault) return;

    if (quantumrootUiState.isStaleInventory) {
      await Toast.show({
        text: 'This approval key is no longer visible. Refresh the vault or choose another key.',
      });
      return;
    }

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
        text: `Failed to configure vault: ${describeQuantumrootError(error)}`,
      });
    } finally {
      setSavingConfiguration(false);
    }
  }, [
    currentWalletId,
    loadQuantumrootWorkspace,
    pendingTokenCategory,
    quantumrootUiState.isStaleInventory,
    selectedVault,
  ]);

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
        text: `Quantumroot spend failed: ${describeQuantumrootError(error)}`,
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
        text: `Quantumroot sweep failed: ${describeQuantumrootError(error)}`,
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

  const handleAuthorizedSpendUtxo = useCallback(
    async (utxo: UTXO, destinationAddress: string) => {
      if (!currentWalletId || !selectedVault || !selectedVaultTokenAwareness) {
        await Toast.show({ text: 'Quantumroot vault unavailable.' });
        return;
      }

      const normalizedDestination = destinationAddress.trim();
      if (!normalizedDestination) {
        await Toast.show({ text: 'Destination address is required.' });
        return;
      }

      const controlTokenUtxo =
        selectedVaultTokenAwareness.matchingControlTokenUtxos[0] ?? null;
      if (!controlTokenUtxo) {
        await Toast.show({
          text: 'No matching Quantum Lock control token is available yet.',
        });
        return;
      }

      const receiveTokenUtxo =
        selectedVaultTokenAwareness.matchingReceiveTokenUtxos.find(
          (candidate) =>
            candidate.tx_hash === utxo.tx_hash && candidate.tx_pos === utxo.tx_pos
        ) ?? null;
      if (!receiveTokenUtxo) {
        await Toast.show({
          text: 'That receive UTXO is not eligible for authorized spend.',
        });
        return;
      }

      const outpointKey = `${receiveTokenUtxo.tx_hash}:${receiveTokenUtxo.tx_pos}`;
      setRecoveringOutpoint(outpointKey);

      let vault: Awaited<ReturnType<typeof KeyService.deriveQuantumrootVault>> | null =
        null;
      let successorVault:
        | Awaited<ReturnType<typeof KeyService.deriveQuantumrootVault>>
        | null = null;

      try {
        vault = await KeyService.deriveQuantumrootVault(
          currentWalletId,
          selectedVault.address_index,
          selectedVault.account_index,
          selectedVault.online_quantum_signer === 1 ? '1' : '0',
          selectedVault.vault_token_category
        );
        successorVault = await KeyService.deriveQuantumrootVault(
          currentWalletId,
          selectedVault.address_index + 1,
          selectedVault.account_index,
          selectedVault.online_quantum_signer === 1 ? '1' : '0',
          selectedVault.vault_token_category
        );

        const built = buildQuantumrootAuthorizedSpendTransaction({
          controlTokenUtxo,
          destinationAddress: normalizedDestination,
          receiveUtxos: [receiveTokenUtxo],
          successorQuantumLockAddress: successorVault.quantumLockAddress,
          successorQuantumLockLockingBytecode: successorVault.quantumLockLockingBytecode,
          vault,
          vaultTokenCategory: selectedVault.vault_token_category,
        });

        await validateQuantumrootAuthorizedSpendAgainstFulcrum({
          controlTokenUtxo,
          destinationAddress: normalizedDestination,
          rawTransaction: built.rawTransaction,
          receiveUtxos: [receiveTokenUtxo],
          successorQuantumLockAddress: successorVault.quantumLockAddress,
          successorQuantumLockLockingBytecode:
            successorVault.quantumLockLockingBytecode,
          vault,
          vaultTokenCategory: selectedVault.vault_token_category,
        });

        const sent = await TransactionService.sendTransaction(
          built.rawTransaction,
          [controlTokenUtxo, receiveTokenUtxo],
          {
            source: 'quantumroot-authorized-spend',
            sourceLabel: 'Quantumroot Authorized Spend',
            recipientSummary: normalizedDestination,
            amountSummary: built.recoveryAmountSats.toString(),
            userPrompt: 'Spend token-authorized funds from a Quantumroot vault',
          }
        );

        if (!sent.txid) {
          throw new Error(
            sent.errorMessage || 'Failed to broadcast Quantumroot authorized spend.'
          );
        }

        await Toast.show({
          text: `Quantumroot authorized spend broadcast: ${shortenTxHash(sent.txid)}`,
        });
        await loadQuantumrootWorkspace();
    } catch (error) {
      console.error('Quantumroot authorized spend failed from workspace:', error);
      await Toast.show({
        text: `Quantumroot authorized spend failed: ${describeQuantumrootError(error)}`,
      });
    } finally {
      if (vault) {
        zeroizeQuantumrootArtifacts(vault);
        }
        if (successorVault) {
          zeroizeQuantumrootArtifacts(successorVault);
        }
        setRecoveringOutpoint(null);
      }
    },
    [
      currentWalletId,
      loadQuantumrootWorkspace,
      selectedVault,
      selectedVaultTokenAwareness,
    ]
  );

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
        text: `Quantum Lock recovery failed: ${describeQuantumrootError(error)}`,
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
    refreshing,
    loadError,
    syncing,
    selectedVault,
    recoveringOutpoint,
    sweepingAll,
    pendingSpendAddress,
    pendingTokenCategory,
    savingConfiguration,
    quantumrootPlainNftFamilies,
    quantumrootUiState,
    portfolio,
    selectedVaultStatus,
    selectedVaultTokenAwareness,
    walletTokenInventory,
    recoveryDestinationAddress,
    loadQuantumrootWorkspace,
    handleSyncVaults,
    handleSaveVaultConfiguration,
    handleSpendUtxo,
    handleAuthorizedSpendUtxo,
    handleSweepAllReceiveUtxos,
    handleRecoverQuantumLockUtxo,
    setSelectedVault,
    setPendingSpendAddress,
    setPendingTokenCategory,
  };
}
