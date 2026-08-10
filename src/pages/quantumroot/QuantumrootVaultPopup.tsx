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
import {
  shortenAddress,
  shortenHash,
  shortenTxHash,
} from '../../utils/shortenHash';
import { SATSINBITCOIN } from '../../utils/constants';
import {
  resolveTokenPresentation,
  shortTokenCategory,
} from '../../utils/tokenPresentation';
import type { QuantumrootTokenAwareness } from '../../services/QuantumrootTokenAwarenessService';
import type { QuantumrootWalletTokenSummary } from '../../services/QuantumrootWalletTokenInventoryService';
import type { QuantumrootVaultRecord, UTXO } from '../../types/types';
import type {
  QuantumrootSendFlow,
  QuantumrootUiState,
  VaultStatusView,
} from './quantumrootTypes';
import type { TranslationKey } from '../../i18n/resources';
import { useI18n } from '../../i18n/useI18n';
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

type PopupTranslator = (
  key: TranslationKey,
  values?: Record<string, string | number>
) => string;

function getUtxoStateLabel(height: number, t: PopupTranslator) {
  return height > 0
    ? t('quantumroot.popup.confirmed')
    : t('quantumroot.popup.pending');
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
  neutral:
    'wallet-step-card wallet-surface-strong border border-[var(--wallet-border)]',
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
            <StatusChip
              tone={
                tone === 'success'
                  ? 'success'
                  : tone === 'warning'
                    ? 'warning'
                    : 'neutral'
              }
            >
              {statusLabel}
            </StatusChip>
          </div>
          <div className="mt-1 text-xs wallet-muted">{description}</div>
        </div>
      </div>
    </button>
  );
}

function describeNftCapability(
  capability: 'none' | 'mutable' | 'minting',
  t: PopupTranslator
) {
  switch (capability) {
    case 'mutable':
      return t('quantumroot.popup.mutableNft');
    case 'minting':
      return t('quantumroot.popup.mintingNft');
    default:
      return t('quantumroot.popup.approvalKeyCapability');
  }
}

function getNextActionIcon(
  kind: QuantumrootUiState['nextRequiredAction']['kind']
) {
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
  const { t } = useI18n();
  const navigate = useNavigate();
  const heroAction = quantumrootUiState.nextRequiredAction;
  const localizedHeroAction = (() => {
    switch (heroAction.kind) {
      case 'open-cashtokens':
        return {
          ...heroAction,
          title: t('quantumroot.popup.action.createTitle'),
          label: t('quantumroot.popup.openCashTokens'),
          description: t('quantumroot.popup.action.createDescription'),
        };
      case 'pick-family':
        return {
          ...heroAction,
          title: t('quantumroot.popup.action.chooseTitle'),
          label: t('quantumroot.popup.action.chooseLabel'),
          description: t('quantumroot.popup.action.chooseDescription'),
        };
      case 'refresh-vault':
        return {
          ...heroAction,
          title: t('quantumroot.popup.action.refreshTitle'),
          label: t('quantumroot.popup.action.refreshLabel'),
          description: t('quantumroot.popup.action.refreshDescription'),
        };
      case 'send-approval-token':
        return {
          ...heroAction,
          title: t('quantumroot.popup.action.sendTitle'),
          label: t('quantumroot.popup.action.sendLabel'),
          description: t('quantumroot.popup.action.sendDescription'),
        };
      case 'fund-receive-coin':
        return {
          ...heroAction,
          title: t('quantumroot.popup.action.receiveTitle'),
          label: t('quantumroot.popup.action.receiveLabel'),
          description: t('quantumroot.popup.action.receiveDescription'),
        };
      case 'set-destination':
        return {
          ...heroAction,
          title: t('quantumroot.popup.action.destinationTitle'),
          label: t('quantumroot.popup.action.destinationLabel'),
          description: t('quantumroot.popup.action.destinationDescription'),
        };
      case 'open-spend-list':
      default:
        return {
          ...heroAction,
          title: t('quantumroot.popup.action.readyTitle'),
          label:
            quantumrootUiState.receiveTokenCount > 1
              ? t('quantumroot.popup.action.chooseCoinLabel')
              : t('quantumroot.popup.action.reviewLabel'),
          description: isActiveNetwork
            ? t('quantumroot.popup.action.readyDescription')
            : t('quantumroot.popup.action.disabledDescription'),
        };
    }
  })();
  const localizedBlockingReason = quantumrootUiState.blockingReason
    ? quantumrootUiState.laneState === 'no-family'
      ? t('quantumroot.popup.block.noFamily')
      : quantumrootUiState.laneState === 'pick-family'
        ? t('quantumroot.popup.block.pickFamily')
        : quantumrootUiState.laneState === 'stale-inventory'
          ? t('quantumroot.popup.block.staleInventory')
          : quantumrootUiState.laneState === 'approval-pending'
            ? t('quantumroot.popup.block.approvalPending')
            : quantumrootUiState.laneState === 'receive-pending'
              ? t('quantumroot.popup.block.receivePending')
              : !quantumrootUiState.hasSpendDestination
                ? t('quantumroot.popup.block.noDestination')
                : t('quantumroot.popup.block.inactiveNetwork')
    : null;
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
          scrollToSection(
            isReadyState ? 'quantumroot-ready-spend' : 'quantumroot-token-spend'
          );
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
  const unrelatedQuantumLockTokenCount =
    quantumrootUiState.unrelatedQuantumLockTokenCount;
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
          ? t('quantumroot.popup.normalLaneReady')
          : t('quantumroot.popup.normalLanePending'),
        icon: <FaWallet className="text-[1.05rem]" />,
        onClick: () => scrollToSection('quantumroot-receive-address'),
        statusLabel: isReadyState
          ? t('quantumroot.popup.done')
          : t('quantumroot.popup.neededLater'),
        tone: isReadyState ? ('success' as const) : ('neutral' as const),
        title: t('quantumroot.popup.normalLane'),
        step: '1',
      },
      {
        description: familyReady
          ? t('quantumroot.popup.approvalKeyPicked')
          : t('quantumroot.popup.pickApprovalKey'),
        icon: <FaTag className="text-[1.05rem]" />,
        onClick: () => scrollToSection('quantumroot-token-family'),
        statusLabel: familyReady
          ? t('quantumroot.popup.done')
          : t('quantumroot.popup.needed'),
        tone: familyReady ? ('success' as const) : ('warning' as const),
        title: t('quantumroot.popup.approvalKey'),
        step: '2',
      },
      {
        description: approvalReady
          ? t('quantumroot.popup.approvalKeyInLock')
          : t('quantumroot.popup.sendApprovalKeyToLock'),
        icon: <FaLock className="text-[1.05rem]" />,
        onClick: !familyReady
          ? () => scrollToSection('quantumroot-token-family')
          : approvalReady
            ? () => scrollToSection('quantumroot-token-spend')
            : () =>
                openPrefilledSimpleSend(quantumLockAddress, 'approval-token'),
        statusLabel: approvalReady
          ? t('quantumroot.popup.done')
          : t('quantumroot.popup.waiting'),
        tone: approvalReady ? ('success' as const) : ('warning' as const),
        title: t('quantumroot.popup.quantumLock'),
        step: '3',
      },
      {
        description: spendReady
          ? t('quantumroot.popup.readyCoinAvailable')
          : receiveReady
            ? t('quantumroot.popup.addDestinationReview')
            : t('quantumroot.popup.addMatchingCoin'),
        icon: <FaArrowRight className="text-[1.05rem]" />,
        onClick: !familyReady
          ? () => scrollToSection('quantumroot-token-family')
          : !approvalReady
            ? () =>
                openPrefilledSimpleSend(quantumLockAddress, 'approval-token')
            : receiveReady
              ? () => scrollToSection('quantumroot-token-spend')
              : () => openPrefilledSimpleSend(receiveAddress, 'receive-coin'),
        statusLabel: spendReady
          ? t('quantumroot.popup.ready')
          : t('quantumroot.popup.waiting'),
        tone: spendReady ? ('success' as const) : ('warning' as const),
        title: t('quantumroot.popup.protectedSpend'),
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
    t,
  ]);

  if (!selectedVault) return null;

  return (
    <Popup
      closePopups={onClose}
      closeButtonText={t('quantumroot.close')}
      closeButtonClassName="wallet-btn-secondary w-full my-2"
    >
      <h3 className="mb-4 flex flex-wrap items-center justify-center gap-2 text-center text-xl font-bold">
        <span>
          {t('quantumroot.vaultNumber', { id: selectedVault.address_index })}
        </span>
        <StatusChip tone="neutral">
          {t('quantumroot.betaProduction')}
        </StatusChip>
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
                  {t('quantumroot.popup.nextStep')}
                </div>
                <StatusChip tone={localizedHeroAction.tone}>
                  {localizedHeroAction.label}
                </StatusChip>
              </div>
              <div className="mt-1 text-lg font-semibold wallet-text-strong">
                {localizedHeroAction.title}
              </div>
              <div className="mt-1 text-sm wallet-muted">
                {localizedHeroAction.description}
              </div>
            </div>
          </div>
          <button
            className="wallet-btn-primary mt-3 w-full"
            onClick={executeNextRequiredAction}
            disabled={!localizedHeroAction.enabled}
          >
            {localizedHeroAction.label}
          </button>
          {localizedBlockingReason ? (
            <div className="mt-3 rounded-[14px] border border-[var(--wallet-warning-border)] bg-[color-mix(in_oklab,var(--wallet-warning-bg)_45%,transparent)] p-3 text-sm wallet-warning-text">
              <div className="flex items-start gap-2">
                <FaExclamationTriangle className="mt-0.5 shrink-0" />
                <div>{localizedBlockingReason}</div>
              </div>
            </div>
          ) : null}
        </div>

        {/* sm:/xl: are VIEWPORT breakpoints, but this grid always renders
            inside Popup's max-w-md (448px) panel — on a wide/maximized
            desktop window they activated a 4-column layout squeezed into
            that 448px box, overlapping the cards, while on mobile they
            never triggered at all (narrower than sm: anyway). Using
            auto-fit/minmax instead sizes columns off the ACTUAL rendered
            container width, so it's correct on both a narrow phone
            (1 column) and this capped popup on any desktop window size
            (2 columns) without a mobile regression. */}
        {!isReadyState ? (
          <div className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(150px,1fr))]">
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
                  <div className="font-semibold wallet-text-strong">
                    {t('quantumroot.popup.protectedSpend')}
                  </div>
                  <div className="mt-1 text-xs wallet-muted">
                    {t('quantumroot.popup.reviewDestination')}
                  </div>
                </div>
              </div>
              <StatusChip tone="success">
                {localizedHeroAction.label}
              </StatusChip>
            </div>
            <div className="mt-3 rounded-[14px] border border-[var(--wallet-border)] bg-[color-mix(in_oklab,var(--wallet-accent-soft)_16%,transparent)] p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[11px] uppercase tracking-[0.16em] wallet-muted">
                    {t('quantumroot.popup.destination')}
                  </div>
                  <div className="mt-1 font-semibold wallet-text-strong break-all">
                    {pendingSpendAddress.trim()
                      ? shortenAddress(pendingSpendAddress)
                      : t('quantumroot.popup.noDestination')}
                  </div>
                </div>
                <StatusChip
                  tone={pendingSpendAddress.trim() ? 'success' : 'warning'}
                >
                  {pendingSpendAddress.trim()
                    ? t('quantumroot.popup.ready')
                    : t('quantumroot.popup.missing')}
                </StatusChip>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  className="wallet-btn-secondary px-3 py-2 text-xs"
                  onClick={onUseRecoveryDestination}
                >
                  {t('quantumroot.popup.useRecoveryAddress')}
                </button>
                {pendingSpendAddress.trim() ? (
                  <button
                    className="wallet-btn-secondary px-3 py-2 text-xs"
                    onClick={() => onCopy(pendingSpendAddress)}
                  >
                    {t('quantumroot.popup.copyDestination')}
                  </button>
                ) : null}
              </div>
            </div>
            <div className="mt-3 space-y-2">
              {selectedVaultTokenAwareness?.matchingReceiveTokenUtxos.length ? (
                selectedVaultTokenAwareness.matchingReceiveTokenUtxos.map(
                  (utxo) => {
                    const outpointKey = `${utxo.tx_hash}:${utxo.tx_pos}`;
                    const utxoStateLabel = getUtxoStateLabel(utxo.height, t);
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
                              {utxo.height > 0
                                ? t('quantumroot.popup.readyCoin')
                                : t('quantumroot.popup.pendingCoin')}
                            </div>
                            <div className="mt-2">
                              <StatusChip
                                tone={utxo.height > 0 ? 'success' : 'neutral'}
                              >
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
                            onClick={() =>
                              setPendingAuthorizedSpendReview(utxo)
                            }
                          >
                            {t('quantumroot.popup.reviewSpend')}
                          </button>
                        </div>
                      </div>
                    );
                  }
                )
              ) : (
                <div className="rounded-[14px] border border-dashed border-[var(--wallet-border)] p-3 text-[11px] wallet-muted">
                  {t('quantumroot.popup.noReadyCoin')}
                </div>
              )}
            </div>
          </div>
        ) : null}

        {/* Same container-width rationale as the flowSteps grid above: md: is
            a viewport breakpoint, irrelevant to this always-max-w-md panel. */}
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(160px,1fr))]">
          <div className="wallet-surface-strong rounded-[18px] border border-[var(--wallet-border)] bg-[color-mix(in_oklab,var(--wallet-accent-soft)_24%,transparent)] p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-[color-mix(in_oklab,var(--wallet-accent-soft)_72%,transparent)] text-[var(--wallet-accent-strong)]">
                  <FaWallet />
                </div>
                <div className="min-w-0">
                  <div className="font-semibold wallet-text-strong">
                    {t('quantumroot.popup.normalLane')}
                  </div>
                  <div className="mt-1 text-xs wallet-muted">
                    {t('quantumroot.popup.normalLaneDescription')}
                  </div>
                </div>
              </div>
              <StatusChip tone={receiveBalanceSats > 0 ? 'success' : 'warning'}>
                {receiveBalanceSats > 0
                  ? t('quantumroot.popup.done')
                  : t('quantumroot.popup.needed')}
              </StatusChip>
            </div>
            <div className="mt-2 text-xs wallet-muted">
              {formatBch(receiveBalanceSats)} in the normal lane
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <StatusChip
                tone={
                  selectedVaultStatus?.recoverableReceiveUtxos.length
                    ? 'success'
                    : 'neutral'
                }
              >
                {t('quantumroot.popup.plainBchCoins', {
                  count:
                    selectedVaultStatus?.recoverableReceiveUtxos.length ?? 0,
                })}
              </StatusChip>
              <StatusChip
                tone={matchingReceiveTokenCount > 0 ? 'success' : 'warning'}
              >
                {t('quantumroot.popup.readyCoins', {
                  count: matchingReceiveTokenCount,
                })}
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
                  <div className="font-semibold wallet-text-strong">
                    {t('quantumroot.popup.approvalLane')}
                  </div>
                  <div className="mt-1 text-xs wallet-muted">
                    {t('quantumroot.popup.approvalLaneDescription')}
                  </div>
                </div>
              </div>
              <StatusChip
                tone={matchingControlTokenCount > 0 ? 'success' : 'warning'}
              >
                {matchingControlTokenCount > 0
                  ? t('quantumroot.popup.done')
                  : t('quantumroot.popup.waiting')}
              </StatusChip>
            </div>
            <div className="mt-2 text-xs wallet-muted">
              {matchingControlTokenCount > 0
                ? t('quantumroot.popup.approvalKeyInQuantumLock')
                : t('quantumroot.popup.sendSelectedApprovalKey')}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <StatusChip tone="neutral">
                {t('quantumroot.popup.inWallet', {
                  count: approvalKeyWalletCount,
                })}
              </StatusChip>
              <StatusChip
                tone={approvalKeyQuantumLockCount > 0 ? 'success' : 'warning'}
              >
                {t('quantumroot.popup.inQuantumLock', {
                  count: approvalKeyQuantumLockCount,
                })}
              </StatusChip>
              <StatusChip
                tone={
                  unrelatedQuantumLockTokenCount > 0 ? 'warning' : 'neutral'
                }
              >
                {t('quantumroot.popup.otherNfts', {
                  count: unrelatedQuantumLockTokenCount,
                })}
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
                  <div className="font-semibold">
                    {t('quantumroot.popup.otherNftInQuantumLock')}
                  </div>
                  <div className="mt-1 text-xs">
                    {t('quantumroot.popup.otherNftDescription')}
                  </div>
                </div>
              </div>
              <StatusChip tone="warning">
                {t('quantumroot.popup.locked', {
                  count:
                    selectedVaultTokenAwareness?.unrelatedQuantumLockTokenUtxos
                      .length ?? 0,
                })}
              </StatusChip>
            </div>
            <div className="mt-3 space-y-2">
              {selectedVaultTokenAwareness?.unrelatedQuantumLockTokenUtxos.map(
                (utxo) => {
                  const tokenMetadata =
                    walletTokenMetadata[utxo.token?.category ?? ''] ?? null;
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
                            <div className="text-xs font-semibold">
                              {t('quantumroot.popup.otherNft')}
                            </div>
                            <div className="mt-1 text-[11px] wallet-muted">
                              {formatBch(utxo.value ?? utxo.amount ?? 0)}
                            </div>
                          </div>
                        }
                      />
                    </div>
                  );
                }
              )}
            </div>
          </div>
        ) : null}

        <details className="wallet-surface-strong rounded-[18px] border border-[var(--wallet-border)] p-3 text-sm">
          <summary className="flex cursor-pointer list-none items-start justify-between gap-3">
            <div>
              <div className="font-semibold">
                {t('quantumroot.popup.vaultSetup')}
              </div>
              <div className="text-[11px] wallet-muted">
                {t('quantumroot.popup.vaultSetupDescription')}
              </div>
            </div>
            <StatusChip tone="neutral">
              {t('quantumroot.popup.tapToOpen')}
            </StatusChip>
          </summary>
          <div className="mt-4 space-y-3">
            <div id="quantumroot-receive-address">
              <SelectableValueCard
                label={t('quantumroot.popup.receiveAddress')}
                value={receiveAddress}
                qrValue={receiveAddress}
                onCopy={onCopy}
                copyLabel={t('quantumroot.popup.copyReceiveAddress')}
                helperText={
                  isPreviewOnly
                    ? t('quantumroot.popup.previewOnly')
                    : t('quantumroot.popup.copyOrScanFund')
                }
              />
            </div>
            <div id="quantumroot-quantum-lock">
              <SelectableValueCard
                label={t('quantumroot.popup.quantumLock')}
                value={quantumLockAddress}
                onCopy={onCopy}
                copyLabel={t('quantumroot.popup.copyQuantumLock')}
                helperText={t('quantumroot.popup.sendApprovalHere')}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="wallet-surface-strong rounded-[14px] p-3">
                <div className="text-[11px] font-semibold wallet-muted mb-1">
                  {t('quantumroot.popup.receiveBch')}
                </div>
                <div className="font-bold">
                  {formatBch(selectedVaultStatus?.receiveBalanceSats ?? 0)}
                </div>
              </div>
              <div className="wallet-surface-strong rounded-[14px] p-3">
                <div className="text-[11px] font-semibold wallet-muted mb-1">
                  {t('quantumroot.popup.quantumLockBch')}
                </div>
                <div className="font-bold">
                  {formatBch(selectedVaultStatus?.quantumLockBalanceSats ?? 0)}
                </div>
              </div>
            </div>
            <div className="wallet-surface-strong rounded-[14px] p-3">
              <div className="flex flex-wrap gap-2">
                <StatusChip
                  tone={selectedFamilySummary ? 'success' : 'warning'}
                >
                  {selectedFamilySummary
                    ? t('quantumroot.popup.approvalKeySelected')
                    : t('quantumroot.popup.noApprovalKey')}
                </StatusChip>
                <StatusChip
                  tone={approvalKeyWalletCount > 0 ? 'success' : 'warning'}
                >
                  {t('quantumroot.popup.inWallet', {
                    count: approvalKeyWalletCount,
                  })}
                </StatusChip>
                <StatusChip
                  tone={approvalKeyQuantumLockCount > 0 ? 'success' : 'warning'}
                >
                  {t('quantumroot.popup.inQuantumLock', {
                    count: approvalKeyQuantumLockCount,
                  })}
                </StatusChip>
              </div>
              {selectedVaultTokenAwareness?.matchingControlTokenUtxos.length ? (
                <div className="mt-3 space-y-2">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.16em] wallet-muted">
                    {t('quantumroot.popup.availableApprovalKeys')}
                  </div>
                  <div className="space-y-2">
                    {selectedVaultTokenAwareness.matchingControlTokenUtxos.map(
                      (utxo) => {
                        const outpointKey = `${utxo.tx_hash}:${utxo.tx_pos}`;
                        const utxoStateLabel = getUtxoStateLabel(
                          utxo.height,
                          t
                        );
                        return (
                          <div
                            key={outpointKey}
                            className="rounded-[14px] border border-[var(--wallet-border)] bg-[color-mix(in_oklab,var(--wallet-accent-soft)_18%,transparent)] p-3"
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div>
                                <div className="font-semibold">
                                  {describeNftCapability(
                                    utxo.token?.nft?.capability ?? 'none',
                                    t
                                  )}
                                </div>
                              </div>
                              <div className="text-right">
                                <div className="font-bold">
                                  {formatBch(utxo.value ?? utxo.amount ?? 0)}
                                </div>
                                <StatusChip
                                  tone={utxo.height > 0 ? 'success' : 'neutral'}
                                >
                                  {utxoStateLabel}
                                </StatusChip>
                              </div>
                            </div>
                          </div>
                        );
                      }
                    )}
                  </div>
                </div>
              ) : null}
              <div className="mt-2 text-[11px] wallet-muted">
                {t('quantumroot.popup.quantumrootOpens')}
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
              <div className="font-semibold">
                {t('quantumroot.popup.chooseApprovalKey')}
              </div>
              <div className="text-[11px] wallet-muted">
                {t('quantumroot.popup.chooseApprovalKeyDescription')}
              </div>
            </div>
            <StatusChip
              tone={
                quantumrootPlainNftFamilies.length > 0 ? 'neutral' : 'warning'
              }
            >
              {t('quantumroot.popup.available', {
                count: quantumrootPlainNftFamilies.length,
              })}
            </StatusChip>
          </div>

          {quantumrootUiState.isStaleInventory ? (
            <div className="mb-3 rounded-[14px] border border-[var(--wallet-warning-border)] bg-[color-mix(in_oklab,var(--wallet-warning-bg)_34%,transparent)] p-3 text-sm wallet-warning-text">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="font-semibold">
                    {t('quantumroot.popup.approvalKeyChanged')}
                  </div>
                  <div className="mt-1 text-xs">
                    {t('quantumroot.popup.refreshChooseAnother')}
                  </div>
                </div>
                <button
                  className="wallet-btn-secondary px-3 py-2 text-xs"
                  onClick={onRefreshVault}
                >
                  {t('quantumroot.popup.refresh')}
                </button>
              </div>
            </div>
          ) : null}

          {selectedFamilySummary && pendingTokenPresentation ? (
            <div className="rounded-[14px] border border-[var(--wallet-border)] bg-[color-mix(in_oklab,var(--wallet-accent-soft)_40%,transparent)] p-3">
              <div className="text-[11px] font-semibold wallet-muted mb-2">
                {t('quantumroot.popup.selectedApprovalKey')}
              </div>
              <TokenIdentityBadge
                presentation={pendingTokenPresentation}
                showStatus={false}
                detail={
                  <div className="shrink-0 text-right">
                    <div className="text-xs wallet-muted">
                      {t('quantumroot.popup.available', {
                        count: selectedFamilySummary.plainNftUtxoCount,
                      })}
                    </div>
                  </div>
                }
              />
              <div className="mt-2 text-[11px] wallet-muted break-all">
                {t('quantumroot.popup.category')}{' '}
                {shortTokenCategory(selectedFamilySummary.category)}
              </div>
              <StatusChip tone="neutral">
                {t('quantumroot.popup.available', {
                  count: selectedFamilySummary.plainNftUtxoCount,
                })}
              </StatusChip>
            </div>
          ) : (
            <div className="rounded-[14px] border border-dashed border-[var(--wallet-border)] bg-[color-mix(in_oklab,var(--wallet-surface)_78%,transparent)] p-3 text-[11px] wallet-muted">
              {t('quantumroot.popup.chooseOneApproval')}
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
              {savingConfiguration
                ? t('quantumroot.popup.saving')
                : t('quantumroot.popup.saveApprovalKey')}
            </button>
            <button
              className="wallet-btn-secondary px-4 py-2"
              onClick={onRefreshVault}
            >
              <FaSyncAlt className="inline-block align-[-0.1em] mr-2" />
              {t('quantumroot.popup.refreshVault')}
            </button>
            {!quantumrootUiState.familyCount ? (
              <button
                className="wallet-btn-secondary px-4 py-2"
                onClick={openCashTokensScreen}
              >
                {t('quantumroot.popup.openCashTokens')}
              </button>
            ) : null}
          </div>

          <div className="mt-3">
            {quantumrootPlainNftFamilies.length > 0 ? (
              <div className="max-h-64 space-y-2 overflow-y-auto pr-1">
                {quantumrootPlainNftFamilies.map((token) => {
                  const tokenMetadata =
                    walletTokenMetadata[token.category] ?? null;
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
                              {t('quantumroot.popup.available', {
                                count: token.plainNftUtxoCount,
                              })}
                            </div>
                          </div>
                        }
                      />
                      {isSelected ? (
                        <div className="mt-2 text-[11px] font-semibold wallet-accent-text">
                          {t('quantumroot.popup.selectedAsApproval')}
                        </div>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="rounded-[14px] border border-dashed border-[var(--wallet-border)] p-3 text-[11px] wallet-muted">
                {t('quantumroot.popup.createOrReceive')}
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
                <div className="font-semibold">
                  {t('quantumroot.popup.protectedSpend')}
                </div>
                <div className="text-[11px] wallet-muted">
                  {t('quantumroot.popup.protectedSpendDescription')}
                </div>
              </div>
              <StatusChip
                tone={
                  quantumrootUiState.canAuthorizedSpend ? 'success' : 'warning'
                }
              >
                {localizedHeroAction.label}
              </StatusChip>
            </div>
            <div className="mt-2 rounded-[14px] border border-[var(--wallet-border)] bg-[color-mix(in_oklab,var(--wallet-accent-soft)_16%,transparent)] p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[11px] uppercase tracking-[0.16em] wallet-muted">
                    {t('quantumroot.popup.spendDestination')}
                  </div>
                  <div className="mt-1 font-semibold wallet-text-strong break-all">
                    {pendingSpendAddress.trim()
                      ? shortenAddress(pendingSpendAddress)
                      : t('quantumroot.popup.noDestination')}
                  </div>
                  <div className="mt-1 text-[11px] wallet-muted">
                    {t('quantumroot.popup.reviewDestination')}
                  </div>
                </div>
                <StatusChip
                  tone={pendingSpendAddress.trim() ? 'success' : 'warning'}
                >
                  {pendingSpendAddress.trim()
                    ? t('quantumroot.popup.ready')
                    : t('quantumroot.popup.missing')}
                </StatusChip>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  className="wallet-btn-secondary px-3 py-2 text-xs"
                  onClick={onUseRecoveryDestination}
                >
                  {t('quantumroot.popup.useRecoveryAddress')}
                </button>
                {pendingSpendAddress.trim() ? (
                  <button
                    className="wallet-btn-secondary px-3 py-2 text-xs"
                    onClick={() => onCopy(pendingSpendAddress)}
                  >
                    {t('quantumroot.popup.copyDestination')}
                  </button>
                ) : null}
              </div>
            </div>
            {!quantumrootUiState.canAuthorizedSpend ? (
              <div className="mt-3 rounded-[14px] border border-dashed border-[var(--wallet-border)] p-3 text-[11px] wallet-muted">
                {localizedBlockingReason ??
                  t('quantumroot.popup.completeSteps')}
              </div>
            ) : null}
            <div className="space-y-2">
              <ActionTile
                title={t('quantumroot.popup.sendApprovalKey')}
                description={t('quantumroot.popup.sendApprovalKeyDescription')}
                icon={<FaShieldAlt />}
                onClick={
                  selectedFamilySummary
                    ? () =>
                        openPrefilledSimpleSend(
                          quantumLockAddress,
                          'approval-token'
                        )
                    : undefined
                }
                disabled={
                  !selectedFamilySummary || quantumrootUiState.isStaleInventory
                }
                compact
                layout="horizontal"
                trailing={
                  <StatusChip
                    tone={matchingControlTokenCount > 0 ? 'success' : 'warning'}
                  >
                    {t('quantumroot.popup.found', {
                      count:
                        selectedVaultTokenAwareness?.matchingControlTokenUtxos
                          .length ?? 0,
                    })}
                  </StatusChip>
                }
              />
              <ActionTile
                title={t('quantumroot.popup.fundMatchingReceive')}
                description={t(
                  'quantumroot.popup.fundMatchingReceiveDescription'
                )}
                icon={<FaQrcode />}
                onClick={
                  selectedFamilySummary
                    ? () =>
                        openPrefilledSimpleSend(receiveAddress, 'receive-coin')
                    : undefined
                }
                disabled={
                  !selectedFamilySummary || quantumrootUiState.isStaleInventory
                }
                compact
                layout="horizontal"
                trailing={
                  <StatusChip
                    tone={matchingReceiveTokenCount > 0 ? 'success' : 'warning'}
                  >
                    {t('quantumroot.popup.readyCoins', {
                      count:
                        selectedVaultTokenAwareness?.matchingReceiveTokenUtxos
                          .length ?? 0,
                    })}
                  </StatusChip>
                }
              />
            </div>
            {selectedVaultTokenAwareness?.matchingReceiveTokenUtxos.length ? (
              <div className="space-y-2 mt-3">
                {selectedVaultTokenAwareness.matchingReceiveTokenUtxos.map(
                  (utxo) => {
                    const outpointKey = `${utxo.tx_hash}:${utxo.tx_pos}`;
                    const isAuthorizedSpend =
                      recoveringOutpoint === outpointKey;
                    const utxoStateLabel = getUtxoStateLabel(utxo.height, t);
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
                              {describeNftCapability(
                                utxo.token?.nft?.capability ?? 'none',
                                t
                              )}
                            </div>
                            <div className="text-[11px] wallet-muted break-all">
                              {t('quantumroot.popup.commitment')}{' '}
                              {shortenHash(
                                utxo.token?.nft?.commitment ?? '',
                                8,
                                6
                              ) || t('quantumroot.popup.empty')}
                            </div>
                            <div className="text-[11px] wallet-muted mt-1">
                              {t('quantumroot.popup.outpoint')}{' '}
                              {shortenHash(utxo.tx_hash, 8, 6)}:{utxo.tx_pos}
                            </div>
                            <div className="mt-2">
                              <StatusChip
                                tone={utxo.height > 0 ? 'success' : 'neutral'}
                              >
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
                            onClick={() =>
                              setPendingAuthorizedSpendReview(utxo)
                            }
                          >
                            {t('quantumroot.popup.reviewSpend')}
                          </button>
                        </div>
                      </div>
                    );
                  }
                )}
              </div>
            ) : (
              <div className="rounded-[14px] border border-dashed border-[var(--wallet-border)] p-3 text-[11px] wallet-muted">
                {t('quantumroot.popup.noReadyCoin')}
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
              <div className="font-semibold">
                {t('quantumroot.popup.advancedRecovery')}
              </div>
              <div className="text-[11px] wallet-muted">
                {t('quantumroot.popup.advancedRecoveryDescription')}
              </div>
            </div>
            <StatusChip tone="neutral">
              {t('quantumroot.popup.advanced')}
            </StatusChip>
          </summary>
          <div className="mt-4 space-y-3">
            <div className="wallet-surface-strong rounded-[14px] p-3">
              <div className="text-[11px] font-semibold wallet-muted mb-1">
                {t('quantumroot.popup.walletRecoveryAddress')}
              </div>
              <div className="text-sm break-all">
                {recoveryDestinationAddress
                  ? shortenAddress(recoveryDestinationAddress)
                  : t('quantumroot.popup.noStandardAddress')}
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  className="wallet-btn-secondary px-3 py-2 text-xs"
                  disabled={!recoveryDestinationAddress}
                  onClick={onUseRecoveryDestination}
                >
                  {t('quantumroot.popup.useRecoveryAddress')}
                </button>
                <button
                  className="wallet-btn-secondary px-3 py-2 text-xs"
                  disabled={!recoveryDestinationAddress}
                  onClick={() =>
                    recoveryDestinationAddress &&
                    onCopy(recoveryDestinationAddress)
                  }
                >
                  {t('quantumroot.popup.copyRecoveryAddress')}
                </button>
              </div>
              <div className="text-[11px] wallet-muted mt-2">
                {t('quantumroot.popup.bchRecoveryDescription')}
              </div>
            </div>

            <div className="wallet-surface-strong rounded-[14px] p-3">
              <div className="font-semibold mb-2">
                {t('quantumroot.popup.recoverRegularBch')}
              </div>
              <div className="space-y-3">
                <div>
                  <div className="text-[11px] font-semibold wallet-muted mb-1">
                    {t('quantumroot.popup.destinationAddress')}
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
                    ? t('quantumroot.popup.sweeping')
                    : t('quantumroot.popup.sweepBch', {
                        count:
                          selectedVaultStatus?.recoverableReceiveUtxos.length ??
                          0,
                      })}
                </button>
                <div className="text-[11px] wallet-muted">
                  {bchSpendEnabled
                    ? t('quantumroot.popup.plainBchDescription')
                    : t('quantumroot.popup.bchRecoveryDisabled')}
                </div>
              </div>
            </div>

            {selectedVaultStatus?.recoverableQuantumLockUtxos.length ? (
              <div className="wallet-surface-strong rounded-[14px] p-3 text-sm">
                <div className="font-semibold mb-2">
                  {t('quantumroot.popup.quantumLockRecovery')}
                </div>
                <div className="space-y-2">
                  {selectedVaultStatus.recoverableQuantumLockUtxos.map(
                    (utxo) => {
                      const outpointKey = `${utxo.tx_hash}:${utxo.tx_pos}`;
                      const isRecovering = recoveringOutpoint === outpointKey;
                      const utxoStateLabel = getUtxoStateLabel(utxo.height, t);
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
                                <StatusChip
                                  tone={utxo.height > 0 ? 'success' : 'neutral'}
                                >
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
                                onRecoverQuantumLockUtxo(
                                  utxo,
                                  pendingSpendAddress
                                )
                              }
                            >
                              {isRecovering
                                ? t('quantumroot.popup.recovering')
                                : t('quantumroot.popup.recover')}
                            </button>
                          </div>
                        </div>
                      );
                    }
                  )}
                </div>
              </div>
            ) : null}

            {selectedVaultStatus?.recoverableReceiveUtxos.length ? (
              <div className="wallet-surface-strong rounded-[14px] p-3 text-sm">
                <div className="font-semibold mb-2">
                  {t('quantumroot.popup.recoverableBchCoins')}
                </div>
                <div className="space-y-2">
                  {selectedVaultStatus.recoverableReceiveUtxos.map((utxo) => {
                    const outpointKey = `${utxo.tx_hash}:${utxo.tx_pos}`;
                    const isRecovering = recoveringOutpoint === outpointKey;
                    const utxoStateLabel = getUtxoStateLabel(utxo.height, t);
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
                              <StatusChip
                                tone={utxo.height > 0 ? 'success' : 'neutral'}
                              >
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
                            onClick={() =>
                              onSpendUtxo(utxo, pendingSpendAddress)
                            }
                          >
                            {isRecovering
                              ? t('quantumroot.popup.spending')
                              : t('quantumroot.popup.spend')}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}

            <div className="wallet-surface-strong rounded-[14px] p-3">
              <div className="font-semibold mb-2">
                {t('quantumroot.popup.helpShortcuts')}
              </div>
              <div className="space-y-2">
                <button
                  className="wallet-btn-secondary w-full"
                  onClick={onRefreshVault}
                >
                  {t('quantumroot.popup.refreshVaultStatus')}
                </button>
                <button
                  className="wallet-btn-secondary w-full"
                  onClick={() => {
                    onClose();
                    navigate('/receive', {
                      state: { returnTo: '/quantumroot' },
                    });
                  }}
                >
                  {t('quantumroot.popup.openReceiveScreen')}
                </button>
              </div>
            </div>

            {selectedVaultStatus?.unsupportedReceiveUtxos.length ? (
              <div className="text-xs wallet-muted">
                {t('quantumroot.popup.unsupportedReceive')}
              </div>
            ) : null}
            {selectedVaultStatus?.unsupportedQuantumLockUtxos.length ? (
              <div className="text-xs wallet-muted">
                {t('quantumroot.popup.unsupportedQuantumLock')}
              </div>
            ) : null}
            {isPreviewOnly ? (
              <div className="text-xs wallet-muted">
                {t('quantumroot.popup.mainnetDisabled', {
                  date: activationLabel ?? '—',
                })}
              </div>
            ) : null}
            <div className="text-xs wallet-muted space-y-1">
              <p>
                {t('quantumroot.popup.recoverableBchCount', {
                  count:
                    selectedVaultStatus?.recoverableReceiveUtxos.length ?? 0,
                })}
              </p>
              <p>
                {t('quantumroot.popup.protectedReceiveCount', {
                  count:
                    selectedVaultStatus?.unsupportedReceiveUtxos.length ?? 0,
                })}
              </p>
              <p>
                {t('quantumroot.popup.quantumLockRecoveryCount', {
                  count:
                    selectedVaultStatus?.recoverableQuantumLockUtxos.length ??
                    0,
                })}
              </p>
              <p>
                {t('quantumroot.popup.protectedReceiveCount', {
                  count:
                    selectedVaultStatus?.unsupportedQuantumLockUtxos.length ??
                    0,
                })}
              </p>
            </div>
          </div>
        </details>

        <ContainedSwipeConfirmModal
          open={Boolean(pendingAuthorizedSpendReview)}
          title={t('quantumroot.popup.reviewSpendTitle')}
          subtitle={t('quantumroot.popup.reviewSpendSubtitle')}
          warning={t('quantumroot.popup.broadcastWarning')}
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
                  {t('quantumroot.popup.destination')}
                </div>
                <div className="mt-1 break-all font-semibold wallet-text-strong">
                  {pendingSpendAddress.trim() ||
                    t('quantumroot.popup.noDestination')}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="wallet-surface-strong rounded-[16px] p-3">
                  <div className="text-[11px] uppercase tracking-[0.16em] wallet-muted">
                    {t('quantumroot.popup.readyCoin')}
                  </div>
                  <div className="mt-1 font-bold">
                    {formatBch(
                      pendingAuthorizedSpendReview.value ??
                        pendingAuthorizedSpendReview.amount ??
                        0
                    )}
                  </div>
                  <div className="mt-1 text-[11px] wallet-muted">
                    {getUtxoStateLabel(pendingAuthorizedSpendReview.height, t)}
                  </div>
                </div>
                <div className="wallet-surface-strong rounded-[16px] p-3">
                  <div className="text-[11px] uppercase tracking-[0.16em] wallet-muted">
                    {t('quantumroot.popup.approvalKey')}
                  </div>
                  <div className="mt-1 font-semibold">
                    {selectedFamilySummary
                      ? shortTokenCategory(selectedFamilySummary.category)
                      : t('quantumroot.popup.selectedApprovalKey')}
                  </div>
                  <div className="mt-1 text-[11px] wallet-muted">
                    {t('quantumroot.popup.inQuantumLock', {
                      count: approvalKeyQuantumLockCount,
                    })}
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
