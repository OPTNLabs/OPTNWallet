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
import { TOKEN_OUTPUT_SATS } from '../../utils/constants';
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
import {
  createQuantumrootRecoveryReview,
  type QuantumrootRecoveryReview,
} from './recoveryReview';
import { useI18n } from '../../i18n/useI18n';
import type { TranslationKey } from '../../i18n/resources';

export type QuantumrootBroadcastNotice = {
  txid: string;
  messageKey: TranslationKey;
};

type QuantumrootTranslator = (
  key: TranslationKey,
  values?: Record<string, string | number>
) => string;

function describeQuantumrootError(error: unknown, t: QuantumrootTranslator) {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : t('quantumroot.popup.block.inactiveNetwork');

  if (message.includes('fall below dust after fees')) {
    return t('quantumroot.popup.addMatchingCoin');
  }
  if (message.includes('control token UTXO is not currently visible')) {
    return t('quantumroot.toast.approvalKeyMissing');
  }
  if (message.includes('control token category does not match')) {
    return t('quantumroot.popup.block.staleInventory');
  }
  if (
    message.includes(
      'destination output does not match the requested destination address'
    )
  ) {
    return t('quantumroot.toast.destinationRequired');
  }
  if (
    message.includes(
      'Quantumroot authorized spend requires a matching control token category'
    )
  ) {
    return t('quantumroot.popup.block.staleInventory');
  }

  return message;
}

function quantumrootSats(value: number | bigint | string | undefined): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(Math.trunc(value));
  if (typeof value === 'string') return BigInt(value || '0');
  return 0n;
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
  pendingRecoveryReview: QuantumrootRecoveryReview | null;
  recoveryBroadcastNotice: QuantumrootBroadcastNotice | null;
  recoveryReviewLoading: boolean;
  recoveryReviewError: string | null;
  handleCancelRecoveryReview: () => void;
  handleConfirmRecoveryReview: () => Promise<void>;
  setSelectedVault: (vault: QuantumrootVaultRecord | null) => void;
  setPendingSpendAddress: (value: string) => void;
  setPendingTokenCategory: (value: string) => void;
};

export function useQuantumrootWorkspace({
  currentWalletId,
  workspaceEnabled = true,
  isActiveNetwork = true,
}: UseQuantumrootWorkspaceArgs): UseQuantumrootWorkspaceResult {
  const { t } = useI18n();
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
  const [selectedVault, setSelectedVault] =
    useState<QuantumrootVaultRecord | null>(null);
  const [recoveringOutpoint, setRecoveringOutpoint] = useState<string | null>(
    null
  );
  const [sweepingAll, setSweepingAll] = useState(false);
  const [pendingSpendAddress, setPendingSpendAddress] = useState('');
  const [pendingTokenCategory, setPendingTokenCategory] = useState('');
  const [savingConfiguration, setSavingConfiguration] = useState(false);
  const [pendingRecoveryReview, setPendingRecoveryReview] =
    useState<QuantumrootRecoveryReview | null>(null);
  const [recoveryBroadcastNotice, setRecoveryBroadcastNotice] =
    useState<QuantumrootBroadcastNotice | null>(null);
  const [recoveryReviewLoading, setRecoveryReviewLoading] = useState(false);
  const [recoveryReviewError, setRecoveryReviewError] = useState<string | null>(
    null
  );

  useEffect(() => {
    if (!selectedVault) {
      setPendingRecoveryReview(null);
      setRecoveryBroadcastNotice(null);
      setRecoveryReviewError(null);
    }
  }, [selectedVault]);

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
      const keys = (await KeyService.retrieveKeys(
        currentWalletId
      )) as WalletKey[];
      setWalletKeys(keys);

      const nextVaults =
        await KeyService.retrieveQuantumrootVaults(currentWalletId);
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
          ? await UTXOService.fetchAndStoreUTXOsMany(
              currentWalletId,
              allAddresses
            )
          : {};
      setWalletTokenInventory(
        summarizeQuantumrootWalletTokenInventory(
          Object.values(utxosByAddress).flat()
        )
      );

      const nextStatuses = Object.fromEntries(
        nextVaults.map((vault) => {
          const receiveUtxos = utxosByAddress[vault.receive_address] ?? [];
          const quantumLockUtxos =
            utxosByAddress[vault.quantum_lock_address] ?? [];
          const receiveBuckets = bucketQuantumrootReceiveUtxos(receiveUtxos);
          const quantumLockBuckets =
            bucketQuantumrootReceiveUtxos(quantumLockUtxos);
          return [
            vault.address_index,
            {
              ...summarizeQuantumrootVaultStatus(
                receiveUtxos,
                quantumLockUtxos
              ),
              ...receiveBuckets,
              recoverableQuantumLockUtxos:
                quantumLockBuckets.recoverableReceiveUtxos,
              unsupportedQuantumLockUtxos:
                quantumLockBuckets.unsupportedReceiveUtxos,
            },
          ];
        })
      ) as Record<number, VaultStatusView>;

      setStatusesByIndex(nextStatuses);
      setTokenAwarenessByIndex(
        Object.fromEntries(
          nextVaults.map((vault) => {
            const receiveUtxos = utxosByAddress[vault.receive_address] ?? [];
            const quantumLockUtxos =
              utxosByAddress[vault.quantum_lock_address] ?? [];
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
      setLoadError(
        (error as Error).message || t('quantumroot.workspaceRefreshFailed')
      );
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [currentWalletId, t, workspaceEnabled]);

  useEffect(() => {
    void loadQuantumrootWorkspace();
  }, [loadQuantumrootWorkspace]);

  const handleSyncVaults = useCallback(async () => {
    if (!currentWalletId || !workspaceEnabled) {
      await Toast.show({
        text: t('quantumroot.toast.previewActive'),
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
  }, [currentWalletId, loadQuantumrootWorkspace, t, workspaceEnabled]);

  const portfolio = useMemo(() => {
    const statuses = Object.values(statusesByIndex);
    return {
      totalBalanceSats: statuses.reduce(
        (sum, status) => sum + status.totalBalanceSats,
        0
      ),
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
        text: t('quantumroot.toast.approvalKeyMissing'),
      });
      return;
    }

    const normalized = pendingTokenCategory
      .trim()
      .replace(/^0x/i, '')
      .toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(normalized)) {
      await Toast.show({ text: t('quantumroot.toast.invalidTokenCategory') });
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
      await Toast.show({ text: t('quantumroot.toast.reconfigured') });
    } catch (error) {
      console.error('Failed to configure Quantumroot vault:', error);
      await Toast.show({
        text: t('quantumroot.toast.configureFailed', {
          message: describeQuantumrootError(error, t),
        }),
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
    t,
  ]);

  const handleSpendUtxo = useCallback(
    async (utxo: UTXO, destinationAddress: string) => {
      if (!currentWalletId || !selectedVault) {
        await Toast.show({ text: t('quantumroot.toast.unavailable') });
        return;
      }

      const normalizedDestination = destinationAddress.trim();
      if (!normalizedDestination) {
        await Toast.show({ text: t('quantumroot.toast.destinationRequired') });
        return;
      }

      const outpointKey = `${utxo.tx_hash}:${utxo.tx_pos}`;
      setRecoveringOutpoint(outpointKey);
      setRecoveryReviewError(null);

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
          setPendingRecoveryReview(
            createQuantumrootRecoveryReview({
              kind: 'spend',
              destinationAddress: normalizedDestination,
              sweptUtxos: [utxo],
              feeSats: built.feeSats,
              recoveryAmountSats: built.recoveryAmountSats,
              rawTransaction: built.rawTransaction,
              transactionByteLength: built.transactionByteLength,
            })
          );
        } finally {
          zeroizeQuantumrootArtifacts(vault);
        }
      } catch (error) {
        console.error('Quantumroot spend failed from workspace:', error);
        await Toast.show({
          text: t('quantumroot.toast.spendFailed', {
            message: describeQuantumrootError(error, t),
          }),
        });
      } finally {
        setRecoveringOutpoint(null);
      }
    },
    [currentWalletId, selectedVault, t]
  );

  const handleSweepAllReceiveUtxos = useCallback(async () => {
    if (!currentWalletId || !selectedVault || !selectedVaultStatus) {
      await Toast.show({ text: t('quantumroot.toast.unavailable') });
      return;
    }

    const normalizedDestination = pendingSpendAddress.trim();
    if (!normalizedDestination) {
      await Toast.show({ text: t('quantumroot.toast.destinationRequired') });
      return;
    }

    if (selectedVaultStatus.recoverableReceiveUtxos.length === 0) {
      await Toast.show({ text: t('quantumroot.toast.noBchUtxos') });
      return;
    }

    setSweepingAll(true);
    setRecoveryReviewError(null);
    try {
      const vault = await KeyService.deriveQuantumrootVault(
        currentWalletId,
        selectedVault.address_index,
        selectedVault.account_index,
        selectedVault.online_quantum_signer === 1 ? '1' : '0',
        selectedVault.vault_token_category
      );

      try {
        const aggregateSweep =
          buildQuantumrootAggregateRecoverySweepTransaction({
            destinationAddress: normalizedDestination,
            utxos: selectedVaultStatus.recoverableReceiveUtxos,
            vault,
            vaultTokenCategory: selectedVault.vault_token_category,
          });
        setPendingRecoveryReview(
          createQuantumrootRecoveryReview({
            kind: 'sweep',
            destinationAddress: normalizedDestination,
            sweptUtxos: aggregateSweep.sweptUtxos,
            feeSats: aggregateSweep.feeSats,
            recoveryAmountSats: aggregateSweep.recoveryAmountSats,
            rawTransaction: aggregateSweep.rawTransaction,
            transactionByteLength: aggregateSweep.transactionByteLength,
          })
        );
      } finally {
        zeroizeQuantumrootArtifacts(vault);
      }
    } catch (error) {
      console.error('Quantumroot sweep failed from workspace:', error);
      await Toast.show({
        text: t('quantumroot.toast.sweepFailed', {
          message: describeQuantumrootError(error, t),
        }),
      });
    } finally {
      setSweepingAll(false);
    }
  }, [
    currentWalletId,
    pendingSpendAddress,
    selectedVault,
    selectedVaultStatus,
    t,
  ]);

  const handleAuthorizedSpendUtxo = useCallback(
    async (utxo: UTXO, destinationAddress: string) => {
      if (!currentWalletId || !selectedVault || !selectedVaultTokenAwareness) {
        await Toast.show({ text: t('quantumroot.toast.unavailable') });
        return;
      }

      const normalizedDestination = destinationAddress.trim();
      if (!normalizedDestination) {
        await Toast.show({ text: t('quantumroot.toast.destinationRequired') });
        return;
      }

      const controlTokenUtxo =
        selectedVaultTokenAwareness.matchingControlTokenUtxos[0] ?? null;
      if (!controlTokenUtxo) {
        await Toast.show({
          text: t('quantumroot.toast.noControlToken'),
        });
        return;
      }

      const receiveTokenUtxo =
        selectedVaultTokenAwareness.matchingReceiveTokenUtxos.find(
          (candidate) =>
            candidate.tx_hash === utxo.tx_hash &&
            candidate.tx_pos === utxo.tx_pos
        ) ?? null;
      if (!receiveTokenUtxo) {
        await Toast.show({
          text: t('quantumroot.toast.ineligibleReceiveUtxo'),
        });
        return;
      }

      const outpointKey = `${receiveTokenUtxo.tx_hash}:${receiveTokenUtxo.tx_pos}`;
      setRecoveringOutpoint(outpointKey);

      let vault: Awaited<
        ReturnType<typeof KeyService.deriveQuantumrootVault>
      > | null = null;
      let successorVault: Awaited<
        ReturnType<typeof KeyService.deriveQuantumrootVault>
      > | null = null;

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
          successorQuantumLockLockingBytecode:
            successorVault.quantumLockLockingBytecode,
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

        const controlInputSats = quantumrootSats(
          controlTokenUtxo.value ?? controlTokenUtxo.amount
        );
        setPendingRecoveryReview(
          createQuantumrootRecoveryReview({
            kind: 'authorized',
            destinationAddress: normalizedDestination,
            sweptUtxos: [controlTokenUtxo, ...built.sweptUtxos],
            feeSats: built.feeSats,
            recoveryAmountSats: built.recoveryAmountSats,
            reservedOutputSats: BigInt(
              Math.max(Number(TOKEN_OUTPUT_SATS), Number(controlInputSats))
            ),
            rawTransaction: built.rawTransaction,
            transactionByteLength: built.transactionByteLength,
          })
        );
      } catch (error) {
        console.error(
          'Quantumroot authorized spend failed from workspace:',
          error
        );
        await Toast.show({
          text: t('quantumroot.toast.authorizedFailed', {
            message: describeQuantumrootError(error, t),
          }),
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
    [currentWalletId, selectedVault, selectedVaultTokenAwareness, t]
  );

  const handleRecoverQuantumLockUtxo = useCallback(
    async (utxo: UTXO, destinationAddress: string) => {
      if (!currentWalletId || !selectedVault) {
        await Toast.show({ text: t('quantumroot.toast.unavailable') });
        return;
      }

      const normalizedDestination = destinationAddress.trim();
      if (!normalizedDestination) {
        await Toast.show({ text: t('quantumroot.toast.destinationRequired') });
        return;
      }

      const outpointKey = `${utxo.tx_hash}:${utxo.tx_pos}`;
      setRecoveringOutpoint(outpointKey);
      setRecoveryReviewError(null);

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
          setPendingRecoveryReview(
            createQuantumrootRecoveryReview({
              kind: 'quantum-lock',
              destinationAddress: normalizedDestination,
              sweptUtxos: [utxo],
              feeSats: built.feeSats,
              recoveryAmountSats: built.recoveryAmountSats,
              rawTransaction: built.rawTransaction,
              transactionByteLength: built.transactionByteLength,
            })
          );
        } finally {
          zeroizeQuantumrootArtifacts(vault);
        }
      } catch (error) {
        console.error('Quantum Lock recovery failed from workspace:', error);
        await Toast.show({
          text: t('quantumroot.toast.lockRecoveryFailed', {
            message: describeQuantumrootError(error, t),
          }),
        });
      } finally {
        setRecoveringOutpoint(null);
      }
    },
    [currentWalletId, selectedVault, t]
  );

  const handleCancelRecoveryReview = useCallback(() => {
    if (recoveryReviewLoading) return;
    setPendingRecoveryReview(null);
    setRecoveryReviewError(null);
  }, [recoveryReviewLoading]);

  const handleConfirmRecoveryReview = useCallback(async () => {
    if (!pendingRecoveryReview || recoveryReviewLoading) return;

    setRecoveryReviewLoading(true);
    setRecoveryReviewError(null);
    setRecoveryBroadcastNotice(null);
    try {
      const source =
        pendingRecoveryReview.kind === 'sweep'
          ? {
              source: 'quantumroot-sweep',
              sourceLabel: 'Quantumroot Sweep',
              userPrompt: 'Sweep BCH from Quantumroot receive UTXOs',
              successKey: 'quantumroot.toast.sweepBroadcast' as const,
            }
          : pendingRecoveryReview.kind === 'quantum-lock'
            ? {
                source: 'quantumroot-quantum-lock-recovery',
                sourceLabel: 'Quantum Lock Recovery',
                userPrompt: 'Recover BCH from a Quantumroot Quantum Lock UTXO',
                successKey: 'quantumroot.toast.lockRecoveryBroadcast' as const,
              }
            : pendingRecoveryReview.kind === 'authorized'
              ? {
                  source: 'quantumroot-authorized-spend',
                  sourceLabel: 'Quantumroot Authorized Spend',
                  userPrompt:
                    'Spend token-authorized funds from a Quantumroot vault',
                  successKey: 'quantumroot.toast.authorizedBroadcast' as const,
                }
              : {
                  source: 'quantumroot-spend',
                  sourceLabel: 'Quantumroot Spend',
                  userPrompt: 'Spend BCH from a Quantumroot receive address',
                  successKey: 'quantumroot.toast.spendBroadcast' as const,
                };

      const sent = await TransactionService.sendTransaction(
        pendingRecoveryReview.rawTransaction,
        pendingRecoveryReview.sweptUtxos,
        {
          source: source.source,
          sourceLabel: source.sourceLabel,
          recipientSummary: pendingRecoveryReview.destinationAddress,
          amountSummary: pendingRecoveryReview.recoveryAmountSats.toString(),
          userPrompt: source.userPrompt,
        }
      );
      if (!sent.txid) {
        throw new Error(
          sent.errorMessage ||
            t(
              source.successKey === 'quantumroot.toast.sweepBroadcast'
                ? 'quantumroot.toast.broadcastSweepFailed'
                : source.successKey ===
                    'quantumroot.toast.lockRecoveryBroadcast'
                  ? 'quantumroot.toast.broadcastLockRecoveryFailed'
                  : source.successKey ===
                      'quantumroot.toast.authorizedBroadcast'
                    ? 'quantumroot.toast.broadcastAuthorizedFailed'
                    : 'quantumroot.toast.broadcastSpendFailed'
            )
        );
      }

      setPendingRecoveryReview(null);
      setRecoveryBroadcastNotice({
        txid: sent.txid,
        messageKey: source.successKey,
      });
      await Toast.show({
        text: t('history.awaitingConfirmation'),
      });
      await loadQuantumrootWorkspace();
    } catch (error) {
      const message = describeQuantumrootError(error, t);
      console.error('Quantumroot recovery broadcast failed:', error);
      setRecoveryReviewError(message);
      await Toast.show({
        text: message,
      });
    } finally {
      setRecoveryReviewLoading(false);
    }
  }, [
    loadQuantumrootWorkspace,
    pendingRecoveryReview,
    recoveryReviewLoading,
    t,
  ]);

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
    pendingRecoveryReview,
    recoveryBroadcastNotice,
    recoveryReviewLoading,
    recoveryReviewError,
    handleCancelRecoveryReview,
    handleConfirmRecoveryReview,
    setSelectedVault,
    setPendingSpendAddress,
    setPendingTokenCategory,
  };
}
