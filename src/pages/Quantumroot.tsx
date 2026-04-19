import React, { useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSelector } from 'react-redux';
import { Toast } from '@capacitor/toast';

import PageHeader from '../components/ui/PageHeader';
import SectionCard from '../components/ui/SectionCard';
import EmptyState from '../components/ui/EmptyState';
import Popup from '../components/transaction/Popup';
import { RootState } from '../redux/store';
import { selectCurrentNetwork } from '../redux/selectors/networkSelectors';
import { SATSINBITCOIN } from '../utils/constants';
import { shortenTxHash } from '../utils/shortenHash';
import { getQuantumrootNetworkSupport } from '../services/QuantumrootNetworkSupportService';
import QuantumrootVaultPopup from './quantumroot/QuantumrootVaultPopup';
import { useQuantumrootWorkspace } from './quantumroot/useQuantumrootWorkspace';

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
  const [showVaultsPopup, setShowVaultsPopup] = React.useState(false);
  const currentWalletId = useSelector(
    (state: RootState) => state.wallet_id.currentWalletId
  );
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
    recoveryDestinationAddress,
    handleSyncVaults,
    handleSaveVaultConfiguration,
    handleSpendUtxo,
    handleSweepAllReceiveUtxos,
    handleRecoverQuantumLockUtxo,
    setSelectedVault,
    setPendingSpendAddress,
    setPendingTokenCategory,
  } = useQuantumrootWorkspace({
    currentWalletId,
    workspaceEnabled: !networkSupport.isPreviewOnly,
  });

  return (
    <div className="container mx-auto max-w-md h-[calc(100dvh-var(--navbar-height)-var(--safe-bottom))] px-4 pt-4 pb-[calc(var(--safe-bottom)+1rem)] flex flex-col overflow-hidden wallet-page">
      <PageHeader
        title="Quantumroot"
        subtitle="Dedicated vault workspace"
        compact
      />

      <SectionCard className="mt-3">
        <div className="wallet-surface-strong rounded-[14px] p-3 mb-3">
          <div className="text-sm font-bold">
            {networkSupport.isPreviewOnly
              ? 'Quantumroot Mainnet Preview'
              : 'Quantumroot Active Workspace'}
          </div>
          <div className="text-xs wallet-muted mt-1">
            {networkSupport.isPreviewOnly
              ? `Quantumroot is visible on mainnet ahead of activation. The layout stays available, but key actions remain disabled until ${formatActivationDate(networkSupport.activationAt)}.`
              : 'Quantumroot is active on this network. Use the vault workspace below to manage receive addresses, sweeps, and recovery.'}
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
            Live now: receive addresses, balance tracking, receive sweeps, Quantum
            Lock BCH recovery.
          </p>
          <p>
            In progress: token-authorized Quantumroot spends and token-aware recovery.
          </p>
        </div>
      </SectionCard>

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
                                ? 'Refreshing…'
                                : (status?.recoverableReceiveUtxos.length ?? 0) > 0
                                ? `${status?.recoverableReceiveUtxos.length ?? 0} recoverable`
                                : status?.isFunded
                                  ? 'Funded'
                                  : 'Unfunded'}
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
          navigate(`/home/${currentWalletId}`);
        }}
        onCopy={(value) => void handleCopy(value)}
        onSpendAddressChange={setPendingSpendAddress}
        onTokenCategoryChange={setPendingTokenCategory}
        onUseRecoveryDestination={() => setPendingSpendAddress(recoveryDestinationAddress ?? '')}
        onSweepAll={() => void handleSweepAllReceiveUtxos()}
        onSaveConfiguration={() => void handleSaveVaultConfiguration()}
        onSpendUtxo={(utxo, destinationAddress) =>
          void handleSpendUtxo(utxo, destinationAddress)
        }
        onRecoverQuantumLockUtxo={(utxo, destinationAddress) =>
          void handleRecoverQuantumLockUtxo(utxo, destinationAddress)
        }
      />
    </div>
  );
};

export default Quantumroot;
