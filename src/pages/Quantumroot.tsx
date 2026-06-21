import React, { useCallback, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useSelector } from 'react-redux';
import { Toast } from '@capacitor/toast';

import PageHeader from '../components/ui/PageHeader';
import SectionCard from '../components/ui/SectionCard';
import EmptyState from '../components/ui/EmptyState';
import StatusChip from '../components/ui/StatusChip';
import Popup from '../components/transaction/Popup';
import { RootState } from '../state/store';
import { selectCurrentNetwork } from '../state/selectors/networkSelectors';
import { SATSINBITCOIN } from '../utils/constants';
import { shortenTxHash } from '../utils/shortenHash';
import { getReturnPath } from '../utils/navigation';
import { getQuantumrootNetworkSupport } from '../services/QuantumrootNetworkSupportService';
import QuantumrootVaultPopup from './quantumroot/QuantumrootVaultPopup';
import { useQuantumrootWorkspace } from './quantumroot/useQuantumrootWorkspace';
import WalletScreen from '../components/ui/WalletScreen';

function formatBch(sats: number) {
  return `${(sats / SATSINBITCOIN).toFixed(8).replace(/\.?0+$/, '') || '0'} BCH`;
}

function formatActivationDate(date: Date | null) {
  if (!date) return null;
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

const QUANTUMROOT_BCH_SPEND_ENABLED = true;

const Quantumroot: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [showVaultsPopup, setShowVaultsPopup] = React.useState(false);
  const currentWalletId = useSelector(
    (state: RootState) => state.wallet_id.currentWalletId
  );
  const returnTarget = getReturnPath(location, `/home/${currentWalletId}`);
  const currentNetwork = useSelector((state: RootState) =>
    selectCurrentNetwork(state)
  );
  const networkSupport = useMemo(
    () => getQuantumrootNetworkSupport(currentNetwork),
    [currentNetwork]
  );

  const handleCopy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      await Toast.show({ text: 'Copied to clipboard!' });
    } catch (error) {
      console.error('Failed to copy Quantumroot value:', error);
      await Toast.show({ text: 'Failed to copy.' });
    }
  }, []);

  const {
    vaults,
    statusesByIndex,
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
    portfolio,
    selectedVaultStatus,
    selectedVaultTokenAwareness,
    quantumrootPlainNftFamilies,
    quantumrootUiState,
    tokenAwarenessByIndex,
    recoveryDestinationAddress,
    handleSyncVaults,
    handleSaveVaultConfiguration,
    loadQuantumrootWorkspace,
    handleSpendUtxo,
    handleAuthorizedSpendUtxo,
    handleSweepAllReceiveUtxos,
    handleRecoverQuantumLockUtxo,
    setSelectedVault,
    setPendingSpendAddress,
    setPendingTokenCategory,
  } = useQuantumrootWorkspace({
    currentWalletId,
    workspaceEnabled: !networkSupport.isPreviewOnly,
    isActiveNetwork: networkSupport.isActive,
  });

  return (
    <WalletScreen maxWidthClassName="max-w-md">
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex-1 min-h-0">
          <PageHeader
            title="Quantumroot"
            subtitle="Two spending lanes in one vault"
            compact
            titleAction={<StatusChip tone="neutral">Beta production</StatusChip>}
          />

          <SectionCard className="mt-3">
            <div className="wallet-surface-strong rounded-[14px] p-3 mb-3">
              <div className="flex flex-wrap items-center gap-2 text-sm font-bold">
                <span>Quantumroot Beta Production</span>
                <StatusChip tone="neutral">Live preview</StatusChip>
              </div>
              <div className="mt-1 text-xs wallet-muted">
                {networkSupport.isPreviewOnly
                  ? 'Mainnet preview stays visible before activation.'
                  : 'Active workspace for the beta-production Quantumroot flow.'}
              </div>
              <div className="mt-1 text-xs wallet-muted">
                {networkSupport.isPreviewOnly
                  ? `Quantumroot is visible on mainnet ahead of activation. The layout stays available, but key actions remain disabled until ${formatActivationDate(networkSupport.activationAt)}.`
                  : 'Quantumroot is active on this network. Use the vault workspace below to manage a normal spend lane and a quantum-safe recovery lane.'}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="wallet-surface-strong rounded-[14px] p-3">
                <div className="text-[11px] font-semibold wallet-muted mb-1">
                  Tracked Balance
                </div>
                <div className="font-bold text-lg">
                  {formatBch(portfolio.totalBalanceSats)}
                </div>
              </div>
              <div className="wallet-surface-strong rounded-[14px] p-3">
                <div className="text-[11px] font-semibold wallet-muted mb-1">
                  Vaults
                </div>
                <div className="font-bold text-lg">{vaults.length}</div>
                <div className="text-[11px] wallet-muted mt-1">
                  {portfolio.fundedVaults} funded
                </div>
              </div>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <button
                className="wallet-btn-primary w-full"
                onClick={() => void handleSyncVaults()}
                disabled={syncing || loading}
              >
                {syncing ? 'Syncing Vaults…' : 'Sync Vaults'}
              </button>
              <button
                className="wallet-btn-secondary w-full"
                onClick={() => setShowVaultsPopup(true)}
              >
                Open Vaults
              </button>
            </div>
            <div className="mt-3 text-xs wallet-muted space-y-1">
              <p>
                Live now: normal spending, balance tracking, and Quantum Lock BCH recovery.
              </p>
              <p>
                Guided now: choose one approval key, lock it in Quantum Lock, then spend the matching coin.
              </p>
            </div>
          </SectionCard>
        </div>

        <div className="mt-auto pb-2 pt-3">
          <button
            className="wallet-btn-danger w-full"
            onClick={() => navigate(returnTarget)}
          >
            Back
          </button>
        </div>
      </div>

      {showVaultsPopup && (
        <Popup closePopups={() => setShowVaultsPopup(false)} closeButtonText="Close">
          <SectionCard
            title="Vaults"
            titleClassName="text-center"
            className="p-0 wallet-card border-none bg-transparent shadow-none"
          >
            <div className="space-y-3">
              {loadError ? (
                <div className="wallet-surface-strong rounded-[14px] p-3 mb-3">
                  <div className="text-sm font-bold">Workspace Refresh Failed</div>
                  <div className="text-xs wallet-muted mt-1">{loadError}</div>
                </div>
              ) : null}
              {loading && vaults.length === 0 ? (
                <div className="flex items-center justify-center py-6">
                  <span className="wallet-spinner" aria-hidden="true" />
                </div>
              ) : vaults.length === 0 ? (
                <EmptyState message="No Quantumroot vaults derived yet. Sync vaults to provision them for existing wallet address indexes." />
              ) : (
                <div className="space-y-3 max-h-[55dvh] overflow-y-auto pr-1">
                  {refreshing ? (
                    <div className="wallet-surface-strong rounded-[14px] px-3 py-2 flex items-center gap-2">
                      <span className="wallet-spinner" aria-hidden="true" />
                      <span className="text-xs wallet-muted">
                        Refreshing balances and UTXO status. Vaults remain available while sync completes.
                      </span>
                    </div>
                  ) : null}
                  {vaults.map((vault) => {
                    const status = statusesByIndex[vault.address_index];
                    const tokenAwareness = tokenAwarenessByIndex[vault.address_index];
                    return (
                      <button
                        key={`${vault.account_index}-${vault.address_index}`}
                        className="wallet-card p-4 w-full text-left hover:brightness-[0.98]"
                        onClick={() => setSelectedVault(vault)}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className="text-sm font-bold">
                              Vault #{vault.address_index}
                            </div>
                            <div className="text-[11px] wallet-muted mt-1">
                              {shortenTxHash(vault.receive_address)}
                            </div>
                          </div>
                          <div className="text-right">
                            <div className="font-bold">
                              {formatBch(status?.totalBalanceSats ?? 0)}
                            </div>
                            <div className="text-[11px] wallet-muted mt-1">
                              {!status && refreshing
                                ? 'Checking balances…'
                                : tokenAwareness?.readinessLabel ??
                                  ((status?.recoverableReceiveUtxos.length ?? 0) > 0
                                    ? `${status?.recoverableReceiveUtxos.length ?? 0} ready to recover`
                                    : status?.isFunded
                                      ? 'Funded'
                                      : 'No funds yet')}
                            </div>
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </SectionCard>
        </Popup>
      )}

      <QuantumrootVaultPopup
        selectedVault={selectedVault}
        selectedVaultStatus={selectedVaultStatus}
        selectedVaultTokenAwareness={selectedVaultTokenAwareness}
        quantumrootPlainNftFamilies={quantumrootPlainNftFamilies}
        quantumrootUiState={quantumrootUiState}
        recoveryDestinationAddress={recoveryDestinationAddress}
        pendingSpendAddress={pendingSpendAddress}
        pendingTokenCategory={pendingTokenCategory}
        recoveringOutpoint={recoveringOutpoint}
        sweepingAll={sweepingAll}
        savingConfiguration={savingConfiguration}
        isPreviewOnly={networkSupport.isPreviewOnly}
        isActiveNetwork={networkSupport.isActive}
        bchSpendEnabled={QUANTUMROOT_BCH_SPEND_ENABLED}
        activationLabel={formatActivationDate(networkSupport.activationAt)}
        onClose={() => {
          setSelectedVault(null);
          setShowVaultsPopup(false);
          navigate(returnTarget);
        }}
        onCopy={(value) => void handleCopy(value)}
        onSpendAddressChange={setPendingSpendAddress}
        onTokenCategoryChange={setPendingTokenCategory}
        onUseRecoveryDestination={() => setPendingSpendAddress(recoveryDestinationAddress ?? '')}
        onSweepAll={() => void handleSweepAllReceiveUtxos()}
        onSaveConfiguration={() => void handleSaveVaultConfiguration()}
        onRefreshVault={() => void loadQuantumrootWorkspace()}
        onSpendUtxo={(utxo, destinationAddress) =>
          void handleSpendUtxo(utxo, destinationAddress)
        }
        onAuthorizedSpendUtxo={(utxo, destinationAddress) =>
          void handleAuthorizedSpendUtxo(utxo, destinationAddress)
        }
        onRecoverQuantumLockUtxo={(utxo, destinationAddress) =>
          void handleRecoverQuantumLockUtxo(utxo, destinationAddress)
        }
      />
    </WalletScreen>
  );
};

export default Quantumroot;
