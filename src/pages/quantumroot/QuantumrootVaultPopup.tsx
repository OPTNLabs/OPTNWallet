import React, { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  FaArrowRight,
  FaBitcoin,
  FaCheckCircle,
  FaExclamationTriangle,
  FaQrcode,
  FaLock,
  FaWallet,
  FaShieldAlt,
  FaSyncAlt,
  FaTag,
} from 'react-icons/fa';

import ActionTile from '../../components/ui/ActionTile';
import Popup from '../../components/transaction/Popup';
import StatusChip from '../../components/ui/StatusChip';
import TokenIdentityBadge from '../../components/ui/TokenIdentityBadge';
import { shortenAddress, shortenHash, shortenTxHash } from '../../utils/shortenHash';
import { SATSINBITCOIN } from '../../utils/constants';
import { resolveTokenPresentation, shortTokenCategory } from '../../utils/tokenPresentation';
import type { QuantumrootTokenAwareness } from '../../services/QuantumrootTokenAwarenessService';
import type { QuantumrootWalletTokenSummary } from '../../services/QuantumrootWalletTokenInventoryService';
import type { QuantumrootVaultRecord, UTXO } from '../../types/types';
import type { QuantumrootSendFlow, QuantumrootUiState, VaultStatusView } from './quantumrootTypes';
import SelectableValueCard from './SelectableValueCard';
import { isConfiguredQuantumrootTokenCategory } from '../../services/QuantumrootTokenAwarenessService';
import useSharedTokenMetadata from '../../hooks/useSharedTokenMetadata';
import { ContainedSwipeConfirmModal } from '../apps/mint-cashtokens-poc/components/uiPrimitives';

type QuantumrootVaultPopupProps = {
  selectedVault: QuantumrootVaultRecord | null;
  selectedVaultStatus: VaultStatusView | null;
  selectedVaultTokenAwareness: QuantumrootTokenAwareness | null;
  quantumrootPlainNftFamilies: QuantumrootWalletTokenSummary[];
  quantumrootUiState: QuantumrootUiState;
  recoveryDestinationAddress: string | null;
  pendingSpendAddress: string;
  pendingTokenCategory: string;
  recoveringOutpoint: string | null;
  sweepingAll: boolean;
  savingConfiguration: boolean;
  isPreviewOnly: boolean;
  isActiveNetwork: boolean;
  bchSpendEnabled: boolean;
  activationLabel: string | null;
  onClose: () => void;
  onCopy: (value: string) => void;
  onSpendAddressChange: (value: string) => void;
  onTokenCategoryChange: (value: string) => void;
  onUseRecoveryDestination: () => void;
  onSweepAll: () => void;
  onSaveConfiguration: () => void;
  onRefreshVault: () => void;
  onSpendUtxo: (utxo: UTXO, destinationAddress: string) => void;
  onAuthorizedSpendUtxo: (utxo: UTXO, destinationAddress: string) => void;
  onRecoverQuantumLockUtxo: (utxo: UTXO, destinationAddress: string) => void;
};

function formatBch(sats: number) {
  return `${(sats / SATSINBITCOIN).toFixed(8).replace(/\.?0+$/, '') || '0'} BCH`;
}

function getUtxoStateLabel(height: number) {
  return height > 0 ? 'Confirmed' : 'Pending';
}

type QuantumrootStepTone = 'success' | 'warning' | 'neutral';

type QuantumrootGuideStepProps = {
  step: string;
  title: string;
  description: string;
  statusLabel: string;
  tone: QuantumrootStepTone;
  icon: React.ReactNode;
  onClick: () => void;
};

const stepToneClass: Record<QuantumrootStepTone, string> = {
  neutral: 'wallet-step-card wallet-surface-strong border border-[var(--wallet-border)]',
  success: 'wallet-success-panel wallet-step-card',
  warning: 'wallet-warning-panel wallet-step-card',
};

function QuantumrootGuideStep({
  step,
  title,
  description,
  statusLabel,
  tone,
  icon,
  onClick,
}: QuantumrootGuideStepProps) {
  return (
    <button
      type="button"
      className={`w-full rounded-[18px] p-3 text-left transition hover:brightness-[0.99] ${stepToneClass[tone]}`.trim()}
      onClick={onClick}
    >
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-[color-mix(in_oklab,var(--wallet-accent-soft)_70%,transparent)] text-[var(--wallet-accent-strong)]">
          <div className="relative">
            <div className="absolute -left-2 -top-2 flex h-4 w-4 items-center justify-center rounded-full bg-[var(--wallet-surface-strong)] text-[9px] font-bold leading-none">
              {step}
            </div>
            {icon}
          </div>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <div className="font-semibold wallet-text-strong">{title}</div>
            <StatusChip tone={tone === 'success' ? 'success' : tone === 'warning' ? 'warning' : 'neutral'}>
              {statusLabel}
            </StatusChip>
          </div>
          <div className="mt-1 text-xs wallet-muted">{description}</div>
        </div>
      </div>
    </button>
  );
}

function describeNftCapability(capability: 'none' | 'mutable' | 'minting') {
  switch (capability) {
    case 'mutable':
      return 'Mutable NFT';
    case 'minting':
      return 'Minting NFT';
    default:
      return 'Approval key';
  }
}

function getNextActionIcon(kind: QuantumrootUiState['nextRequiredAction']['kind']) {
  switch (kind) {
    case 'open-cashtokens':
      return <FaBitcoin className="text-[1.1rem]" />;
    case 'pick-family':
      return <FaTag className="text-[1.1rem]" />;
    case 'send-approval-token':
      return <FaShieldAlt className="text-[1.1rem]" />;
    case 'fund-receive-coin':
      return <FaQrcode className="text-[1.1rem]" />;
    case 'set-destination':
      return <FaArrowRight className="text-[1.1rem]" />;
    case 'refresh-vault':
      return <FaSyncAlt className="text-[1.1rem]" />;
    case 'open-spend-list':
    default:
      return <FaCheckCircle className="text-[1.1rem]" />;
  }
}

const QuantumrootVaultPopup: React.FC<QuantumrootVaultPopupProps> = ({
  selectedVault,
  selectedVaultStatus,
  selectedVaultTokenAwareness,
  quantumrootPlainNftFamilies,
  quantumrootUiState,
  recoveryDestinationAddress,
  pendingSpendAddress,
  pendingTokenCategory,
  recoveringOutpoint,
  sweepingAll,
  savingConfiguration,
  isPreviewOnly,
  isActiveNetwork,
  bchSpendEnabled,
  activationLabel,
  onClose,
  onCopy,
  onSpendAddressChange,
  onTokenCategoryChange,
  onUseRecoveryDestination,
  onSweepAll,
  onSaveConfiguration,
  onRefreshVault,
  onSpendUtxo,
  onAuthorizedSpendUtxo,
  onRecoverQuantumLockUtxo,
}) => {
  const navigate = useNavigate();
  const heroAction = quantumrootUiState.nextRequiredAction;
  const isReadyState = quantumrootUiState.canAuthorizedSpend;
  const [pendingAuthorizedSpendReview, setPendingAuthorizedSpendReview] =
    useState<UTXO | null>(null);
  const walletTokenMetadata = useSharedTokenMetadata(
    quantumrootPlainNftFamilies.map((token) => token.category)
  );
  const selectedFamilySummary = quantumrootUiState.selectedFamilySummary;
  const pendingTokenMetadata = selectedFamilySummary
    ? walletTokenMetadata[selectedFamilySummary.category] ?? null
    : null;
  const pendingTokenPresentation = useMemo(() => {
    if (
      !selectedFamilySummary ||
      !isConfiguredQuantumrootTokenCategory(selectedFamilySummary.category)
    ) {
      return null;
    }

    return resolveTokenPresentation(
      selectedFamilySummary.category,
      pendingTokenMetadata,
      null
    );
  }, [pendingTokenMetadata, selectedFamilySummary]);
  const receiveAddress = selectedVault?.receive_address ?? '';
  const quantumLockAddress = selectedVault?.quantum_lock_address ?? '';
  const scrollToSection = useCallback((sectionId: string) => {
    const element = document.getElementById(sectionId);
    element?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);
  const openCashTokensScreen = useCallback(() => {
    onClose();
    navigate('/mint-cashtokens-poc', { state: { returnTo: '/quantumroot' } });
  }, [navigate, onClose]);
  const openPrefilledSimpleSend = useCallback(
    (recipient: string, flow: QuantumrootSendFlow) => {
      if (!recipient || !selectedFamilySummary) {
        return;
      }

      onClose();
      navigate('/send', {
        state: {
          returnTo: '/quantumroot',
          recipient,
          assetType: 'nft',
          selectedCategory: selectedFamilySummary.category,
          amountToken: '',
          selectedNftCommitment: '',
          quantumrootFlow: flow,
        },
      });
    },
    [navigate, onClose, selectedFamilySummary]
  );
  const executeNextRequiredAction = useCallback(() => {
    switch (quantumrootUiState.nextRequiredAction.kind) {
      case 'open-cashtokens':
        openCashTokensScreen();
        return;
      case 'pick-family':
      case 'set-destination':
      case 'open-spend-list':
        if (quantumrootUiState.nextRequiredAction.kind === 'open-spend-list') {
          scrollToSection(isReadyState ? 'quantumroot-ready-spend' : 'quantumroot-token-spend');
          return;
        }
        if (quantumrootUiState.nextRequiredAction.kind === 'set-destination') {
          scrollToSection('quantumroot-token-spend');
          return;
        }
        scrollToSection('quantumroot-token-family');
        return;
      case 'send-approval-token':
        openPrefilledSimpleSend(quantumLockAddress, 'approval-token');
        return;
      case 'fund-receive-coin':
        openPrefilledSimpleSend(receiveAddress, 'receive-coin');
        return;
      case 'refresh-vault':
        onRefreshVault();
        return;
      default:
        return;
    }
  }, [
    openCashTokensScreen,
    openPrefilledSimpleSend,
    onRefreshVault,
    isReadyState,
    quantumLockAddress,
    quantumrootUiState.nextRequiredAction.kind,
    receiveAddress,
    scrollToSection,
  ]);
  const matchingControlTokenCount = quantumrootUiState.approvalTokenCount;
  const matchingReceiveTokenCount = quantumrootUiState.receiveTokenCount;
  const unrelatedQuantumLockTokenCount = quantumrootUiState.unrelatedQuantumLockTokenCount;
  const receiveBalanceSats = selectedVaultStatus?.receiveBalanceSats ?? 0;
  const approvalKeyWalletCount = selectedFamilySummary?.plainNftUtxoCount ?? 0;
  const approvalKeyQuantumLockCount = matchingControlTokenCount;

  const flowSteps = useMemo(() => {
    const familyReady = Boolean(selectedFamilySummary);
    const approvalReady = matchingControlTokenCount > 0;
    const receiveReady = matchingReceiveTokenCount > 0;
    const spendReady = quantumrootUiState.canAuthorizedSpend;

    return [
      {
        description: isReadyState
          ? 'Your normal lane is ready.'
          : 'Add the matching receive coin after the approval key is in Quantum Lock.',
        icon: <FaWallet className="text-[1.05rem]" />,
        onClick: () => scrollToSection('quantumroot-receive-address'),
        statusLabel: isReadyState ? 'Done' : 'Needed later',
        tone: isReadyState ? ('success' as const) : ('neutral' as const),
        title: 'Normal vault lane',
        step: '1',
      },
      {
        description: familyReady
          ? 'Approval key picked.'
          : 'Pick one approval key.',
        icon: <FaTag className="text-[1.05rem]" />,
        onClick: () => scrollToSection('quantumroot-token-family'),
        statusLabel: familyReady ? 'Done' : 'Needed',
        tone: familyReady ? ('success' as const) : ('warning' as const),
        title: 'Approval key',
        step: '2',
      },
      {
        description: approvalReady
          ? 'Approval key is in Quantum Lock.'
          : 'Send the approval key to Quantum Lock.',
        icon: <FaLock className="text-[1.05rem]" />,
        onClick: !familyReady
          ? () => scrollToSection('quantumroot-token-family')
          : approvalReady
            ? () => scrollToSection('quantumroot-token-spend')
            : () => openPrefilledSimpleSend(quantumLockAddress, 'approval-token'),
        statusLabel: approvalReady ? 'Done' : 'Waiting',
        tone: approvalReady ? ('success' as const) : ('warning' as const),
        title: 'Quantum Lock',
        step: '3',
      },
      {
        description: spendReady
          ? 'Ready coin available.'
          : receiveReady
            ? 'Add a destination, then review spend.'
            : 'Add the matching coin to unlock spend.',
        icon: <FaArrowRight className="text-[1.05rem]" />,
        onClick: !familyReady
          ? () => scrollToSection('quantumroot-token-family')
          : !approvalReady
            ? () => openPrefilledSimpleSend(quantumLockAddress, 'approval-token')
            : receiveReady
              ? () => scrollToSection('quantumroot-token-spend')
              : () => openPrefilledSimpleSend(receiveAddress, 'receive-coin'),
        statusLabel: spendReady ? 'Ready' : 'Waiting',
        tone: spendReady ? ('success' as const) : ('warning' as const),
        title: 'Protected spend',
        step: '4',
      },
    ];
  }, [
    matchingControlTokenCount,
    matchingReceiveTokenCount,
    openPrefilledSimpleSend,
    isReadyState,
    quantumLockAddress,
    quantumrootUiState.canAuthorizedSpend,
    receiveAddress,
    scrollToSection,
    selectedFamilySummary,
  ]);

  if (!selectedVault) return null;

  return (
    <Popup
      closePopups={onClose}
      closeButtonText="Close"
      closeButtonClassName="wallet-btn-secondary w-full my-2"
    >
      <h3 className="mb-4 flex flex-wrap items-center justify-center gap-2 text-center text-xl font-bold">
        <span>Quantumroot Vault #{selectedVault.address_index}</span>
        <StatusChip tone="neutral">Beta production</StatusChip>
      </h3>
      <div className="space-y-3">
        <div className="wallet-surface-strong rounded-[18px] border border-[var(--wallet-border)] bg-[color-mix(in_oklab,var(--wallet-accent-soft)_28%,var(--wallet-surface-strong))] p-4">
          <div className="flex items-start gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-[color-mix(in_oklab,var(--wallet-accent-soft)_72%,transparent)] text-[var(--wallet-accent-strong)]">
              {getNextActionIcon(heroAction.kind)}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <div className="text-[11px] uppercase tracking-[0.16em] wallet-muted">
                  Next step
                </div>
                <StatusChip tone={heroAction.tone}>
                  {heroAction.label}
                </StatusChip>
              </div>
              <div className="mt-1 text-lg font-semibold wallet-text-strong">
                {heroAction.title}
              </div>
              <div className="mt-1 text-sm wallet-muted">
                {heroAction.description}
              </div>
            </div>
          </div>
          <button
            className="wallet-btn-primary mt-3 w-full"
            onClick={executeNextRequiredAction}
            disabled={!heroAction.enabled}
          >
            {heroAction.label}
          </button>
          {quantumrootUiState.blockingReason ? (
            <div className="mt-3 rounded-[14px] border border-[var(--wallet-warning-border)] bg-[color-mix(in_oklab,var(--wallet-warning-bg)_45%,transparent)] p-3 text-sm wallet-warning-text">
              <div className="flex items-start gap-2">
                <FaExclamationTriangle className="mt-0.5 shrink-0" />
                <div>{quantumrootUiState.blockingReason}</div>
              </div>
            </div>
          ) : null}
        </div>

        {!isReadyState ? (
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {flowSteps.map((step) => (
              <QuantumrootGuideStep
                key={step.step}
                step={step.step}
                title={step.title}
                description={step.description}
                statusLabel={step.statusLabel}
                tone={step.tone}
                icon={step.icon}
                onClick={step.onClick}
              />
            ))}
          </div>
        ) : null}

        {isReadyState ? (
          <div
            id="quantumroot-ready-spend"
            className="wallet-surface-strong rounded-[18px] border border-[var(--wallet-border)] bg-[color-mix(in_oklab,var(--wallet-accent-soft)_24%,transparent)] p-4"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-[color-mix(in_oklab,var(--wallet-accent-soft)_72%,transparent)] text-[var(--wallet-accent-strong)]">
                  <FaCheckCircle />
                </div>
                <div className="min-w-0">
                  <div className="font-semibold wallet-text-strong">Protected spend</div>
                  <div className="mt-1 text-xs wallet-muted">
                    Review the destination before broadcasting.
                  </div>
                </div>
              </div>
              <StatusChip tone="success">{heroAction.label}</StatusChip>
            </div>
            <div className="mt-3 rounded-[14px] border border-[var(--wallet-border)] bg-[color-mix(in_oklab,var(--wallet-accent-soft)_16%,transparent)] p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[11px] uppercase tracking-[0.16em] wallet-muted">
                    Destination
                  </div>
                  <div className="mt-1 font-semibold wallet-text-strong break-all">
                    {pendingSpendAddress.trim()
                      ? shortenAddress(pendingSpendAddress)
                      : 'No destination set'}
                  </div>
                </div>
                <StatusChip tone={pendingSpendAddress.trim() ? 'success' : 'warning'}>
                  {pendingSpendAddress.trim() ? 'Ready' : 'Missing'}
                </StatusChip>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <button className="wallet-btn-secondary px-3 py-2 text-xs" onClick={onUseRecoveryDestination}>
                  Use wallet recovery address
                </button>
                {pendingSpendAddress.trim() ? (
                  <button
                    className="wallet-btn-secondary px-3 py-2 text-xs"
                    onClick={() => onCopy(pendingSpendAddress)}
                  >
                    Copy destination
                  </button>
                ) : null}
              </div>
            </div>
            <div className="mt-3 space-y-2">
              {selectedVaultTokenAwareness?.matchingReceiveTokenUtxos.length ? (
                selectedVaultTokenAwareness.matchingReceiveTokenUtxos.map((utxo) => {
                  const outpointKey = `${utxo.tx_hash}:${utxo.tx_pos}`;
                  const utxoStateLabel = getUtxoStateLabel(utxo.height);
                  return (
                    <div
                      key={outpointKey}
                      className="rounded-[14px] border border-[var(--wallet-border)] bg-[color-mix(in_oklab,var(--wallet-surface-strong)_74%,transparent)] p-3"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="font-bold">
                            {formatBch(utxo.value ?? utxo.amount ?? 0)}
                          </div>
                          <div className="mt-1 text-[11px] wallet-muted">
                            {utxo.height > 0 ? 'Ready coin' : 'Pending coin'}
                          </div>
                          <div className="mt-2">
                            <StatusChip tone={utxo.height > 0 ? 'success' : 'neutral'}>
                              {utxoStateLabel}
                            </StatusChip>
                          </div>
                        </div>
                        <button
                          className="wallet-btn-primary px-3 py-2 text-xs"
                          disabled={
                            !quantumrootUiState.canAuthorizedSpend ||
                            !pendingSpendAddress.trim() ||
                            !isActiveNetwork
                          }
                          onClick={() => setPendingAuthorizedSpendReview(utxo)}
                        >
                          Review spend
                        </button>
                      </div>
                    </div>
                  );
                })
              ) : (
                <div className="rounded-[14px] border border-dashed border-[var(--wallet-border)] p-3 text-[11px] wallet-muted">
                  No ready coin is available yet. After the approval key and the
                  matching receive coin are present, spendable coins appear here.
                </div>
              )}
            </div>
          </div>
        ) : null}

        <div className="grid gap-3 md:grid-cols-2">
          <div className="wallet-surface-strong rounded-[18px] border border-[var(--wallet-border)] bg-[color-mix(in_oklab,var(--wallet-accent-soft)_24%,transparent)] p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-[color-mix(in_oklab,var(--wallet-accent-soft)_72%,transparent)] text-[var(--wallet-accent-strong)]">
                  <FaWallet />
                </div>
                <div className="min-w-0">
                  <div className="font-semibold wallet-text-strong">Normal vault lane</div>
                  <div className="mt-1 text-xs wallet-muted">
                    Your BCH and matching receive coin go here.
                  </div>
                </div>
              </div>
              <StatusChip tone={receiveBalanceSats > 0 ? 'success' : 'warning'}>
                {receiveBalanceSats > 0 ? 'Done' : 'Needed'}
              </StatusChip>
            </div>
            <div className="mt-2 text-xs wallet-muted">
              {formatBch(receiveBalanceSats)} in the normal lane
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <StatusChip tone={selectedVaultStatus?.recoverableReceiveUtxos.length ? 'success' : 'neutral'}>
                {selectedVaultStatus?.recoverableReceiveUtxos.length ?? 0} plain BCH coin
                {selectedVaultStatus?.recoverableReceiveUtxos.length === 1 ? '' : 's'}
              </StatusChip>
              <StatusChip tone={matchingReceiveTokenCount > 0 ? 'success' : 'warning'}>
                {matchingReceiveTokenCount} ready coin
                {matchingReceiveTokenCount === 1 ? '' : 's'}
              </StatusChip>
            </div>
          </div>

          <div className="wallet-surface-strong rounded-[18px] border border-[var(--wallet-border)] bg-[color-mix(in_oklab,var(--wallet-warning-bg)_42%,transparent)] p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-[color-mix(in_oklab,var(--wallet-warning-bg)_72%,transparent)] text-[var(--wallet-warning-text)]">
                  <FaLock />
                </div>
                <div className="min-w-0">
                  <div className="font-semibold wallet-text-strong">Approval lane</div>
                  <div className="mt-1 text-xs wallet-muted">
                    Your approval key goes to Quantum Lock.
                  </div>
                </div>
              </div>
              <StatusChip tone={matchingControlTokenCount > 0 ? 'success' : 'warning'}>
                {matchingControlTokenCount > 0 ? 'Done' : 'Waiting'}
              </StatusChip>
            </div>
            <div className="mt-2 text-xs wallet-muted">
              {matchingControlTokenCount > 0
                ? 'Your approval key is in Quantum Lock.'
                : 'Send the selected approval key to Quantum Lock.'}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <StatusChip tone="neutral">
                {approvalKeyWalletCount} in wallet
              </StatusChip>
              <StatusChip tone={approvalKeyQuantumLockCount > 0 ? 'success' : 'warning'}>
                {approvalKeyQuantumLockCount} in Quantum Lock
              </StatusChip>
              <StatusChip tone={unrelatedQuantumLockTokenCount > 0 ? 'warning' : 'neutral'}>
                {unrelatedQuantumLockTokenCount} other NFT
                {unrelatedQuantumLockTokenCount === 1 ? '' : 's'}
              </StatusChip>
            </div>
          </div>
        </div>

        {quantumrootUiState.hasMismatchedQuantumLockToken ? (
          <div className="wallet-warning-panel rounded-[18px] border p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-[color-mix(in_oklab,var(--wallet-warning-bg)_76%,transparent)] text-[var(--wallet-warning-text)]">
                  <FaExclamationTriangle />
                </div>
                <div className="min-w-0">
                  <div className="font-semibold">Other NFT in Quantum Lock</div>
                  <div className="mt-1 text-xs">
                    It sits in Quantum Lock, but it is not the selected approval key.
                    No direct withdrawal path exists yet.
                  </div>
                </div>
              </div>
              <StatusChip tone="warning">
                {selectedVaultTokenAwareness.unrelatedQuantumLockTokenUtxos.length} locked
              </StatusChip>
            </div>
            <div className="mt-3 space-y-2">
              {selectedVaultTokenAwareness.unrelatedQuantumLockTokenUtxos.map((utxo) => {
                const tokenMetadata = walletTokenMetadata[utxo.token?.category ?? ''] ?? null;
                const presentation = resolveTokenPresentation(
                  utxo.token?.category ?? '',
                  tokenMetadata,
                  null
                );
                const outpointKey = `${utxo.tx_hash}:${utxo.tx_pos}`;
                return (
                  <div
                    key={outpointKey}
                    className="rounded-[14px] border border-[var(--wallet-border)] bg-[color-mix(in_oklab,var(--wallet-surface-strong)_76%,transparent)] p-3"
                  >
                    <TokenIdentityBadge
                      presentation={presentation}
                      showStatus={false}
                      detail={
                        <div className="shrink-0 text-right">
                          <div className="text-xs font-semibold">Other NFT</div>
                          <div className="mt-1 text-[11px] wallet-muted">
                            {formatBch(utxo.value ?? utxo.amount ?? 0)}
                          </div>
                        </div>
                      }
                    />
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}

        <details
          className="wallet-surface-strong rounded-[18px] border border-[var(--wallet-border)] p-3 text-sm"
        >
          <summary className="flex cursor-pointer list-none items-start justify-between gap-3">
            <div>
              <div className="font-semibold">Vault setup</div>
              <div className="text-[11px] wallet-muted">
                Copy addresses and choose the approval key.
              </div>
            </div>
            <StatusChip tone="neutral">
              Tap to open
            </StatusChip>
          </summary>
          <div className="mt-4 space-y-3">
            <div id="quantumroot-receive-address">
              <SelectableValueCard
                label="Receive address"
                value={receiveAddress}
                qrValue={receiveAddress}
                onCopy={onCopy}
                copyLabel="Copy receive address"
                helperText={
                  isPreviewOnly
                    ? 'Preview only on mainnet until activation.'
                    : 'Copy or scan to fund this vault.'
                }
              />
            </div>
            <div id="quantumroot-quantum-lock">
              <SelectableValueCard
                label="Quantum Lock"
                value={quantumLockAddress}
                onCopy={onCopy}
                copyLabel="Copy Quantum Lock"
                helperText="Send the approval key here."
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="wallet-surface-strong rounded-[14px] p-3">
                <div className="text-[11px] font-semibold wallet-muted mb-1">
                  Receive BCH
                </div>
                <div className="font-bold">
                  {formatBch(selectedVaultStatus?.receiveBalanceSats ?? 0)}
                </div>
              </div>
              <div className="wallet-surface-strong rounded-[14px] p-3">
                <div className="text-[11px] font-semibold wallet-muted mb-1">
                  Quantum Lock BCH
                </div>
                <div className="font-bold">
                  {formatBch(selectedVaultStatus?.quantumLockBalanceSats ?? 0)}
                </div>
              </div>
            </div>
            <div className="wallet-surface-strong rounded-[14px] p-3">
              <div className="flex flex-wrap gap-2">
                <StatusChip tone={selectedFamilySummary ? 'success' : 'warning'}>
                  {selectedFamilySummary ? 'Approval key selected' : 'No approval key'}
                </StatusChip>
                <StatusChip tone={approvalKeyWalletCount > 0 ? 'success' : 'warning'}>
                  {approvalKeyWalletCount} in wallet
                </StatusChip>
                <StatusChip tone={approvalKeyQuantumLockCount > 0 ? 'success' : 'warning'}>
                  {approvalKeyQuantumLockCount} in Quantum Lock
                </StatusChip>
              </div>
              {selectedVaultTokenAwareness?.matchingControlTokenUtxos.length ? (
                <div className="mt-3 space-y-2">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.16em] wallet-muted">
                    Available approval keys
                  </div>
                  <div className="space-y-2">
                    {selectedVaultTokenAwareness.matchingControlTokenUtxos.map((utxo) => {
                      const outpointKey = `${utxo.tx_hash}:${utxo.tx_pos}`;
                      const utxoStateLabel = getUtxoStateLabel(utxo.height);
                      return (
                        <div
                          key={outpointKey}
                          className="rounded-[14px] border border-[var(--wallet-border)] bg-[color-mix(in_oklab,var(--wallet-accent-soft)_18%,transparent)] p-3"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <div className="font-semibold">
                                {describeNftCapability(utxo.token?.nft?.capability ?? 'none')}
                              </div>
                            </div>
                            <div className="text-right">
                              <div className="font-bold">
                                {formatBch(utxo.value ?? utxo.amount ?? 0)}
                              </div>
                              <StatusChip tone={utxo.height > 0 ? 'success' : 'neutral'}>
                                {utxoStateLabel}
                              </StatusChip>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : null}
              <div className="mt-2 text-[11px] wallet-muted">
                Quantumroot opens once the approval key sits in Quantum Lock and the
                matching receive coin sits in the normal lane.
              </div>
            </div>
          </div>
        </details>

        <div
          id="quantumroot-token-family"
          className="wallet-surface-strong rounded-[14px] p-3 text-sm"
        >
          <div className="flex items-start justify-between gap-3 mb-3">
            <div>
              <div className="font-semibold">Choose approval key</div>
              <div className="text-[11px] wallet-muted">
                Quantumroot uses one plain NFT as the approval key. Advanced token
                tools live in CashTokens.
              </div>
            </div>
            <StatusChip tone={quantumrootPlainNftFamilies.length > 0 ? 'neutral' : 'warning'}>
              {quantumrootPlainNftFamilies.length} available
            </StatusChip>
          </div>

          {quantumrootUiState.isStaleInventory ? (
            <div className="mb-3 rounded-[14px] border border-[var(--wallet-warning-border)] bg-[color-mix(in_oklab,var(--wallet-warning-bg)_34%,transparent)] p-3 text-sm wallet-warning-text">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="font-semibold">Approval key changed on chain</div>
                  <div className="mt-1 text-xs">
                    Refresh the vault or choose another approval key.
                  </div>
                </div>
                <button className="wallet-btn-secondary px-3 py-2 text-xs" onClick={onRefreshVault}>
                  Refresh
                </button>
              </div>
            </div>
          ) : null}

          {selectedFamilySummary && pendingTokenPresentation ? (
            <div className="rounded-[14px] border border-[var(--wallet-border)] bg-[color-mix(in_oklab,var(--wallet-accent-soft)_40%,transparent)] p-3">
              <div className="text-[11px] font-semibold wallet-muted mb-2">
                Selected approval key
              </div>
              <TokenIdentityBadge
                presentation={pendingTokenPresentation}
                showStatus={false}
                detail={
                  <div className="shrink-0 text-right">
                  <div className="text-xs wallet-muted">
                      {selectedFamilySummary.plainNftUtxoCount} available
                    </div>
                  </div>
                }
              />
              <div className="mt-2 text-[11px] wallet-muted break-all">
                Category: {shortTokenCategory(selectedFamilySummary.category)}
              </div>
              <StatusChip tone="neutral">
                {selectedFamilySummary.plainNftUtxoCount} available
              </StatusChip>
            </div>
          ) : (
            <div className="rounded-[14px] border border-dashed border-[var(--wallet-border)] bg-[color-mix(in_oklab,var(--wallet-surface)_78%,transparent)] p-3 text-[11px] wallet-muted">
              Choose one approval key to continue.
            </div>
          )}

          <div className="mt-3 flex flex-wrap gap-2">
            <button
              className="wallet-btn-primary px-4 py-2"
              onClick={onSaveConfiguration}
              disabled={
                savingConfiguration ||
                !selectedFamilySummary ||
                quantumrootUiState.isStaleInventory
              }
            >
              {savingConfiguration ? 'Saving…' : 'Save approval key'}
            </button>
            <button className="wallet-btn-secondary px-4 py-2" onClick={onRefreshVault}>
              <FaSyncAlt className="inline-block align-[-0.1em] mr-2" />
              Refresh vault
            </button>
            {!quantumrootUiState.familyCount ? (
              <button
                className="wallet-btn-secondary px-4 py-2"
                onClick={openCashTokensScreen}
              >
                Open CashTokens
              </button>
            ) : null}
          </div>

          <div className="mt-3">
            {quantumrootPlainNftFamilies.length > 0 ? (
              <div className="max-h-64 space-y-2 overflow-y-auto pr-1">
                {quantumrootPlainNftFamilies.map((token) => {
                  const tokenMetadata = walletTokenMetadata[token.category] ?? null;
                  const presentation = resolveTokenPresentation(
                    token.category,
                    tokenMetadata,
                    null
                  );
                  const isSelected = pendingTokenCategory === token.category;

                  return (
                    <button
                      key={token.category}
                      type="button"
                      className={`wallet-card w-full p-3 text-left transition ${
                        isSelected
                          ? 'border-[var(--wallet-accent)] bg-[color-mix(in_oklab,var(--wallet-accent-soft)_56%,transparent)]'
                          : 'hover:brightness-[0.98]'
                      }`}
                      onClick={() => onTokenCategoryChange(token.category)}
                    >
                      <TokenIdentityBadge
                        presentation={presentation}
                        showStatus={false}
                        detail={
                          <div className="shrink-0 text-right">
                            <div className="text-xs wallet-muted">
                              {token.plainNftUtxoCount} available
                            </div>
                          </div>
                        }
                      />
                      {isSelected ? (
                        <div className="mt-2 text-[11px] font-semibold wallet-accent-text">
                          Selected as approval key
                        </div>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="rounded-[14px] border border-dashed border-[var(--wallet-border)] p-3 text-[11px] wallet-muted">
                Create or receive a plain NFT first, then it will appear here as an
                approval key you can choose.
              </div>
            )}
          </div>
        </div>

        {!isReadyState ? (
          <div
            id="quantumroot-token-spend"
            className="wallet-surface-strong rounded-[14px] p-3 text-sm"
          >
          <div className="flex items-start justify-between gap-3 mb-2">
            <div>
              <div className="font-semibold">Protected spend</div>
              <div className="text-[11px] wallet-muted">
                When the approval key and matching receive coin are present, spending
                opens here.
              </div>
            </div>
            <StatusChip tone={quantumrootUiState.canAuthorizedSpend ? 'success' : 'warning'}>
              {quantumrootUiState.nextRequiredAction.label}
            </StatusChip>
          </div>
            <div className="mt-2 rounded-[14px] border border-[var(--wallet-border)] bg-[color-mix(in_oklab,var(--wallet-accent-soft)_16%,transparent)] p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[11px] uppercase tracking-[0.16em] wallet-muted">
                    Spend destination
                </div>
                  <div className="mt-1 font-semibold wallet-text-strong break-all">
                    {pendingSpendAddress.trim()
                      ? shortenAddress(pendingSpendAddress)
                      : 'No destination set'}
                  </div>
                  <div className="mt-1 text-[11px] wallet-muted">
                    Review the destination before broadcasting.
                  </div>
                </div>
                <StatusChip tone={pendingSpendAddress.trim() ? 'success' : 'warning'}>
                  {pendingSpendAddress.trim() ? 'Ready' : 'Missing'}
                </StatusChip>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <button className="wallet-btn-secondary px-3 py-2 text-xs" onClick={onUseRecoveryDestination}>
                Use wallet recovery address
              </button>
              {pendingSpendAddress.trim() ? (
                <button
                  className="wallet-btn-secondary px-3 py-2 text-xs"
                  onClick={() => onCopy(pendingSpendAddress)}
                >
                  Copy destination
                </button>
              ) : null}
            </div>
          </div>
          {!quantumrootUiState.canAuthorizedSpend ? (
            <div className="mt-3 rounded-[14px] border border-dashed border-[var(--wallet-border)] p-3 text-[11px] wallet-muted">
              {quantumrootUiState.blockingReason ??
                'Complete the approval key and matching receive coin steps before spending.'}
            </div>
          ) : null}
          <div className="space-y-2">
            <ActionTile
              title="Send approval key"
              description="Open the send screen prefilled to Quantum Lock with the selected approval key."
              icon={<FaShieldAlt />}
              onClick={
                selectedFamilySummary
                  ? () => openPrefilledSimpleSend(quantumLockAddress, 'approval-token')
                  : undefined
              }
              disabled={!selectedFamilySummary || quantumrootUiState.isStaleInventory}
              compact
              layout="horizontal"
              trailing={
                <StatusChip tone={matchingControlTokenCount > 0 ? 'success' : 'warning'}>
                  {selectedVaultTokenAwareness?.matchingControlTokenUtxos.length ?? 0} found
                </StatusChip>
              }
            />
            <ActionTile
              title="Fund matching receive coin"
              description="Open the send screen prefilled to the vault receive address with the same approval key."
              icon={<FaQrcode />}
              onClick={
                selectedFamilySummary
                  ? () => openPrefilledSimpleSend(receiveAddress, 'receive-coin')
                  : undefined
              }
              disabled={!selectedFamilySummary || quantumrootUiState.isStaleInventory}
              compact
              layout="horizontal"
              trailing={
                <StatusChip tone={matchingReceiveTokenCount > 0 ? 'success' : 'warning'}>
                  {selectedVaultTokenAwareness?.matchingReceiveTokenUtxos.length ?? 0} ready
                </StatusChip>
              }
            />
          </div>
          {selectedVaultTokenAwareness?.matchingReceiveTokenUtxos.length ? (
            <div className="space-y-2 mt-3">
              {selectedVaultTokenAwareness.matchingReceiveTokenUtxos.map((utxo) => {
                const outpointKey = `${utxo.tx_hash}:${utxo.tx_pos}`;
                const isAuthorizedSpend = recoveringOutpoint === outpointKey;
                const utxoStateLabel = getUtxoStateLabel(utxo.height);
                return (
                  <div
                    key={outpointKey}
                    className="rounded-[14px] p-3 border border-[var(--wallet-border)]"
                  >
                    <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="font-bold">
                            {formatBch(utxo.value ?? utxo.amount ?? 0)}
                          </div>
                          <div className="mt-1 text-[11px] font-semibold wallet-muted">
                            {describeNftCapability(utxo.token?.nft?.capability ?? 'none')}
                        </div>
                        <div className="text-[11px] wallet-muted break-all">
                          Commitment:{' '}
                          {shortenHash(utxo.token?.nft?.commitment ?? '', 8, 6) || 'empty'}
                        </div>
                        <div className="text-[11px] wallet-muted mt-1">
                          Outpoint {shortenHash(utxo.tx_hash, 8, 6)}:{utxo.tx_pos}
                        </div>
                        <div className="mt-2">
                          <StatusChip tone={utxo.height > 0 ? 'success' : 'neutral'}>
                            {utxoStateLabel}
                          </StatusChip>
                        </div>
                      </div>
                        <button
                          className="wallet-btn-primary px-3 py-2 text-xs"
                          disabled={
                            !quantumrootUiState.canAuthorizedSpend ||
                            isAuthorizedSpend ||
                            !pendingSpendAddress.trim() ||
                            !isActiveNetwork
                          }
                          onClick={() => setPendingAuthorizedSpendReview(utxo)}
                        >
                          Review spend
                        </button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
                <div className="rounded-[14px] border border-dashed border-[var(--wallet-border)] p-3 text-[11px] wallet-muted">
                  No ready coin is available yet. After the approval key and the
                  matching receive coin are present, the spend list appears here.
                </div>
              )}
          </div>
        ) : null}

        <details
          id="quantumroot-advanced-recovery"
          className="wallet-surface-strong rounded-[14px] p-3 text-sm"
        >
          <summary className="flex cursor-pointer list-none items-start justify-between gap-3">
            <div>
              <div className="font-semibold">Advanced recovery</div>
              <div className="text-[11px] wallet-muted">
                Recover regular BCH, recover Quantum Lock funds, or refresh vault status.
              </div>
            </div>
            <StatusChip tone="neutral">Advanced</StatusChip>
          </summary>
          <div className="mt-4 space-y-3">
              <div className="wallet-surface-strong rounded-[14px] p-3">
                <div className="text-[11px] font-semibold wallet-muted mb-1">
                  Wallet recovery address
                </div>
                <div className="text-sm break-all">
                  {recoveryDestinationAddress
                    ? shortenAddress(recoveryDestinationAddress)
                    : 'No standard wallet address available'}
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    className="wallet-btn-secondary px-3 py-2 text-xs"
                    disabled={!recoveryDestinationAddress}
                    onClick={onUseRecoveryDestination}
                  >
                    Use wallet recovery address
                  </button>
                  <button
                    className="wallet-btn-secondary px-3 py-2 text-xs"
                    disabled={!recoveryDestinationAddress}
                    onClick={() => recoveryDestinationAddress && onCopy(recoveryDestinationAddress)}
                  >
                    Copy recovery address
                  </button>
                </div>
                <div className="text-[11px] wallet-muted mt-2">
                  BCH recovery sends back to the matching standard wallet address for
                  this vault index when available.
                </div>
              </div>

            <div className="wallet-surface-strong rounded-[14px] p-3">
              <div className="font-semibold mb-2">Recover regular BCH</div>
                <div className="space-y-3">
                  <div>
                    <div className="text-[11px] font-semibold wallet-muted mb-1">
                      Destination address
                    </div>
                    <input
                      value={pendingSpendAddress}
                      onChange={(e) => onSpendAddressChange(e.target.value)}
                      placeholder="bitcoincash:... or bchtest:..."
                      className="w-full px-3 py-2 rounded-[14px] wallet-surface-strong border border-[var(--wallet-border)] outline-none text-sm"
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                    />
                  </div>
                  <button
                    className="wallet-btn-primary w-full"
                    disabled={
                      !bchSpendEnabled ||
                      sweepingAll ||
                      !pendingSpendAddress.trim() ||
                      !isActiveNetwork ||
                      !selectedVaultStatus?.recoverableReceiveUtxos.length
                    }
                    onClick={onSweepAll}
                  >
                    {sweepingAll
                      ? 'Sweeping…'
                    : `Sweep BCH coins (${selectedVaultStatus?.recoverableReceiveUtxos.length ?? 0})`}
                  </button>
                  <div className="text-[11px] wallet-muted">
                    {bchSpendEnabled
                      ? 'Use this for plain BCH coins. Protected coins stay in the lanes above.'
                      : 'BCH recovery is temporarily disabled until the on-chain receive-script validation issue is resolved.'}
                  </div>
                </div>
              </div>

              {selectedVaultStatus?.recoverableQuantumLockUtxos.length ? (
                <div className="wallet-surface-strong rounded-[14px] p-3 text-sm">
                  <div className="font-semibold mb-2">Quantum Lock recovery</div>
                  <div className="space-y-2">
                    {selectedVaultStatus.recoverableQuantumLockUtxos.map((utxo) => {
                      const outpointKey = `${utxo.tx_hash}:${utxo.tx_pos}`;
                      const isRecovering = recoveringOutpoint === outpointKey;
                      const utxoStateLabel = getUtxoStateLabel(utxo.height);
                      return (
                        <div
                          key={outpointKey}
                          className="rounded-[14px] p-3 border border-[var(--wallet-border)]"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <div className="font-bold">
                                {formatBch(utxo.value ?? utxo.amount ?? 0)}
                              </div>
                              <div className="text-[11px] wallet-muted mt-1">
                                {shortenTxHash(utxo.tx_hash)}:{utxo.tx_pos}
                              </div>
                              <div className="mt-2">
                                <StatusChip tone={utxo.height > 0 ? 'success' : 'neutral'}>
                                  {utxoStateLabel}
                                </StatusChip>
                              </div>
                            </div>
                            <button
                              className="wallet-btn-primary px-3 py-2 text-xs"
                              disabled={
                                isRecovering ||
                                !pendingSpendAddress.trim() ||
                                !isActiveNetwork
                              }
                              onClick={() =>
                                onRecoverQuantumLockUtxo(utxo, pendingSpendAddress)
                              }
                            >
                              {isRecovering ? 'Recovering…' : 'Recover'}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : null}

              {selectedVaultStatus?.recoverableReceiveUtxos.length ? (
                <div className="wallet-surface-strong rounded-[14px] p-3 text-sm">
                  <div className="font-semibold mb-2">Recoverable BCH coins</div>
                  <div className="space-y-2">
                    {selectedVaultStatus.recoverableReceiveUtxos.map((utxo) => {
                      const outpointKey = `${utxo.tx_hash}:${utxo.tx_pos}`;
                      const isRecovering = recoveringOutpoint === outpointKey;
                      const utxoStateLabel = getUtxoStateLabel(utxo.height);
                      return (
                        <div
                          key={outpointKey}
                          className="rounded-[14px] p-3 border border-[var(--wallet-border)]"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <div className="font-bold">
                                {formatBch(utxo.value ?? utxo.amount ?? 0)}
                              </div>
                              <div className="text-[11px] wallet-muted mt-1">
                                {shortenTxHash(utxo.tx_hash)}:{utxo.tx_pos}
                              </div>
                              <div className="mt-2">
                                <StatusChip tone={utxo.height > 0 ? 'success' : 'neutral'}>
                                  {utxoStateLabel}
                                </StatusChip>
                              </div>
                            </div>
                            <button
                              className="wallet-btn-primary px-3 py-2 text-xs"
                              disabled={
                                !bchSpendEnabled ||
                                isRecovering ||
                                !pendingSpendAddress.trim() ||
                                !isActiveNetwork
                              }
                              onClick={() => onSpendUtxo(utxo, pendingSpendAddress)}
                            >
                              {isRecovering ? 'Spending…' : 'Spend'}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : null}

              <div className="wallet-surface-strong rounded-[14px] p-3">
                <div className="font-semibold mb-2">Help and shortcuts</div>
                <div className="space-y-2">
                  <button className="wallet-btn-secondary w-full" onClick={onRefreshVault}>
                    Refresh vault status
                  </button>
                  <button
                    className="wallet-btn-secondary w-full"
                    onClick={() => {
                      onClose();
                      navigate('/receive', { state: { returnTo: '/quantumroot' } });
                    }}
                  >
                    Open receive screen
                  </button>
                </div>
              </div>

              {selectedVaultStatus?.unsupportedReceiveUtxos.length ? (
                <div className="text-xs wallet-muted">
                  Coins with an approval key stay in Protected spend; this recovery list
                  only includes plain BCH coins.
                </div>
              ) : null}
              {selectedVaultStatus?.unsupportedQuantumLockUtxos.length ? (
                <div className="text-xs wallet-muted">
                  Coins in Quantum Lock that belong to Protected spend are handled
                  above; this recovery list only includes plain BCH coins.
                </div>
              ) : null}
              {isPreviewOnly ? (
                <div className="text-xs wallet-muted">
                  Mainnet Quantumroot uses the same UI as Chipnet, but the spend,
                  recovery, and token-configuration actions remain disabled until
                  activation on {activationLabel}.
                </div>
              ) : null}
            <div className="text-xs wallet-muted space-y-1">
              <p>Recoverable BCH coins: {selectedVaultStatus?.recoverableReceiveUtxos.length ?? 0}</p>
              <p>
                Coins already handled by Protected spend:{' '}
                {selectedVaultStatus?.unsupportedReceiveUtxos.length ?? 0}
                </p>
                <p>
                  Quantum Lock recovery coins: {selectedVaultStatus?.recoverableQuantumLockUtxos.length ?? 0}
                </p>
                <p>
                Coins already handled by Protected spend:{' '}
                {selectedVaultStatus?.unsupportedQuantumLockUtxos.length ?? 0}
              </p>
            </div>
            </div>
        </details>

        <ContainedSwipeConfirmModal
          open={Boolean(pendingAuthorizedSpendReview)}
          title="Review spend"
          subtitle="Check the destination, approval key, and ready coin before you broadcast."
          warning="This will broadcast after confirmation."
          canConfirm={
            Boolean(pendingAuthorizedSpendReview) &&
            Boolean(pendingSpendAddress.trim()) &&
            isActiveNetwork &&
            Boolean(selectedFamilySummary) &&
            quantumrootUiState.canAuthorizedSpend
          }
          onCancel={() => setPendingAuthorizedSpendReview(null)}
          onConfirm={() => {
            if (!pendingAuthorizedSpendReview) return;
            const reviewUtxo = pendingAuthorizedSpendReview;
            setPendingAuthorizedSpendReview(null);
            onAuthorizedSpendUtxo(reviewUtxo, pendingSpendAddress);
          }}
        >
          {pendingAuthorizedSpendReview ? (
            <div className="space-y-2 px-5 pb-5 text-sm">
              <div className="wallet-surface-strong rounded-[16px] p-3">
                <div className="text-[11px] uppercase tracking-[0.16em] wallet-muted">
                  Destination
                </div>
                <div className="mt-1 break-all font-semibold wallet-text-strong">
                  {pendingSpendAddress.trim() || 'No destination set'}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="wallet-surface-strong rounded-[16px] p-3">
                  <div className="text-[11px] uppercase tracking-[0.16em] wallet-muted">
                    Ready coin
                  </div>
                  <div className="mt-1 font-bold">
                    {formatBch(pendingAuthorizedSpendReview.value ?? pendingAuthorizedSpendReview.amount ?? 0)}
                  </div>
                  <div className="mt-1 text-[11px] wallet-muted">
                    {getUtxoStateLabel(pendingAuthorizedSpendReview.height)}
                  </div>
                </div>
                <div className="wallet-surface-strong rounded-[16px] p-3">
                  <div className="text-[11px] uppercase tracking-[0.16em] wallet-muted">
                    Approval key
                  </div>
                  <div className="mt-1 font-semibold">
                    {selectedFamilySummary
                      ? shortTokenCategory(selectedFamilySummary.category)
                      : 'Selected approval key'}
                  </div>
                  <div className="mt-1 text-[11px] wallet-muted">
                    {approvalKeyQuantumLockCount} in Quantum Lock
                  </div>
                </div>
              </div>
            </div>
          ) : null}
        </ContainedSwipeConfirmModal>
      </div>
    </Popup>
  );
};

export default QuantumrootVaultPopup;
