import React, { useState } from 'react';
import { useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import { Network } from '../../state/slices/networkSlice';
import {
  selectWalletId,
  selectWalletDerivationPath,
  selectWalletDerivationPathSource,
} from '../../state/slices/walletSlice';
import { selectCurrentNetwork } from '../../state/selectors/networkSelectors';
import { homeRoute } from '../../navigation/routes';
import {
  getDefaultPathForNetwork,
  reloadActiveWallet,
  reconfigureActiveWallet,
} from '../../services/WalletReconfigurationService';
import { useI18n } from '../../i18n/useI18n';
import NetworkContextBanner from '../../components/ui/NetworkContextBanner';
import FriendlyErrorPanel from '../../components/ui/FriendlyErrorPanel';
import WalletPopupSheet from '../../components/ui/WalletPopupSheet';
import { logError } from '../../utils/errorHandling';
import {
  networkProfile,
  SELECTABLE_NETWORKS,
} from '../../utils/networkProfile';

// The list, names, descriptions and colours come from `utils/networkProfile.ts`.
// A new network is a `Network` value plus its profile row and infra pool; the
// compiler then points at every other place that has to decide about it.

export const NetworkSettings: React.FC = () => {
  const navigate = useNavigate();
  const currentNetwork = useSelector(selectCurrentNetwork);
  const walletId = useSelector(selectWalletId);
  const currentPath = useSelector(selectWalletDerivationPath);
  const pathSource = useSelector(selectWalletDerivationPathSource);
  const { t } = useI18n();
  const [switching, setSwitching] = useState(false);
  const [pendingNetwork, setPendingNetwork] = useState<Network | null>(null);
  const [failedSwitchTarget, setFailedSwitchTarget] = useState<Network | null>(
    null
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const networkLabel = (network: Network) =>
    t(networkProfile(network).labelKey);

  const networkDescription = (network: Network) =>
    t(networkProfile(network).descriptionKey);

  const requestSwitch = (target: Network) => {
    if (target === currentNetwork || switching) return;
    setErrorMessage(null);
    setStatusMessage(null);
    setFailedSwitchTarget(null);
    setPendingNetwork(target);
  };

  const handleSwitch = async (target: Network) => {
    if (target === currentNetwork || switching || !pendingNetwork) return;
    setPendingNetwork(null);
    setSwitching(true);
    setErrorMessage(null);
    setStatusMessage(null);
    setFailedSwitchTarget(null);

    try {
      const derivationPath =
        pathSource === 'custom' && currentPath
          ? currentPath
          : getDefaultPathForNetwork(target);
      await reconfigureActiveWallet({
        walletId,
        network: target,
        derivationPath,
        derivationPathSource: pathSource === 'custom' ? 'custom' : 'default',
        operation: 'network-switch',
      });
      navigate(homeRoute(walletId));
    } catch (err) {
      logError('[NetworkSettings] network switch failed', err, {
        walletId,
        network: target,
      });
      setErrorMessage(t('settingsNetwork.switchFailed'));
      setFailedSwitchTarget(target);
    } finally {
      setSwitching(false);
    }
  };

  const handleReload = async () => {
    if (switching || walletId <= 0) return;
    setSwitching(true);
    setErrorMessage(null);
    setStatusMessage(null);
    setFailedSwitchTarget(null);
    try {
      await reloadActiveWallet(walletId);
      setStatusMessage(t('settingsNetwork.reloadCompleted'));
    } catch (err) {
      logError('[NetworkSettings] wallet reload failed', err, { walletId });
      setErrorMessage(t('settingsNetwork.reloadFailed'));
    } finally {
      setSwitching(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <NetworkContextBanner
        network={currentNetwork}
        description={networkDescription(currentNetwork)}
      />

      <p className="text-xs wallet-muted leading-relaxed">
        {t('settingsNetwork.description')}
      </p>

      {errorMessage && (
        <FriendlyErrorPanel
          title={t('settingsNetwork.errorTitle')}
          message={errorMessage}
          action={
            <button
              type="button"
              className="wallet-btn-secondary"
              onClick={() => {
                if (failedSwitchTarget) {
                  setErrorMessage(null);
                  setPendingNetwork(failedSwitchTarget);
                  return;
                }
                void handleReload();
              }}
              disabled={switching || walletId <= 0}
            >
              {t('settingsNetwork.retry')}
            </button>
          }
        />
      )}
      {statusMessage && (
        <p
          role="status"
          className="rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] px-3 py-2 text-sm wallet-muted"
        >
          {statusMessage}
        </p>
      )}

      <button
        type="button"
        onClick={() => void handleReload()}
        disabled={switching || walletId <= 0}
        className="wallet-btn-secondary w-full"
      >
        {switching
          ? t('settingsNetwork.reloading')
          : t('settingsNetwork.reload')}
      </button>

      <div className="flex flex-col gap-2">
        {SELECTABLE_NETWORKS.map((network) => {
          const profile = networkProfile(network);
          const isActive = network === currentNetwork;
          return (
            <button
              key={network}
              type="button"
              onClick={() => requestSwitch(network)}
              disabled={isActive || switching}
              aria-pressed={isActive}
              className={`w-full rounded-xl border p-4 text-left transition-colors disabled:cursor-default ${
                isActive
                  ? 'border-[var(--wallet-accent)] bg-[var(--wallet-accent)]/10'
                  : 'border-[var(--wallet-border)] wallet-surface hover:border-[var(--wallet-accent)]/60'
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="flex flex-col gap-0.5">
                  <div className="flex items-center gap-2">
                    <span style={{ color: profile.color }} aria-hidden>
                      ●
                    </span>
                    <span className="font-semibold wallet-text-strong">
                      {t(profile.labelKey)}
                    </span>
                  </div>
                  <p className="text-xs wallet-muted pl-5">
                    {t(profile.descriptionKey)}
                  </p>
                </div>
                {isActive && (
                  <span className="text-xs font-semibold text-[var(--wallet-accent)]">
                    {t('settingsNetwork.active')}
                  </span>
                )}
                {!isActive && switching && (
                  <span className="text-xs wallet-muted animate-pulse">
                    {t('settingsNetwork.switching')}
                  </span>
                )}
              </div>
            </button>
          );
        })}

        {[t('settingsNetwork.regtest')].map((label) => (
          <div
            key={label}
            className="w-full rounded-xl border border-[var(--wallet-border)] wallet-surface p-4 text-left opacity-50 cursor-not-allowed"
            aria-disabled
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="wallet-muted" aria-hidden>
                  ●
                </span>
                <span className="font-semibold wallet-muted">{label}</span>
              </div>
              <span className="text-[10px] font-semibold wallet-muted uppercase tracking-wide">
                {t('settingsNetwork.comingSoon')}
              </span>
            </div>
          </div>
        ))}
      </div>

      {pendingNetwork && (
        <WalletPopupSheet
          ariaLabelledBy="network-switch-title"
          onDismiss={() => setPendingNetwork(null)}
          dismissLabel={t('confirm.cancel')}
          showDismissButton={false}
          footer={
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button
                type="button"
                className="wallet-btn-secondary"
                onClick={() => setPendingNetwork(null)}
                disabled={switching}
              >
                {t('confirm.cancel')}
              </button>
              <button
                type="button"
                className="wallet-btn-primary"
                onClick={() => void handleSwitch(pendingNetwork)}
                disabled={switching}
              >
                Switch to {networkProfile(pendingNetwork).label}
              </button>
            </div>
          }
        >
          <div className="flex flex-col gap-4">
            <div>
              <h2
                id="network-switch-title"
                className="text-lg font-semibold wallet-text-strong"
              >
                Switch to {networkProfile(pendingNetwork).label}
              </h2>
              <p className="mt-1 text-sm wallet-muted">
                {t('settingsNetwork.switchPrompt', {
                  network: networkLabel(pendingNetwork),
                })}
              </p>
            </div>

            <NetworkContextBanner
              network={pendingNetwork}
              description={networkDescription(pendingNetwork)}
            />

            <div className="rounded-xl border border-amber-400/60 bg-amber-500/10 p-3 text-sm text-amber-950 dark:text-amber-100">
              {pendingNetwork === Network.MAINNET && (
                <p className="font-semibold">
                  {t('settingsNetwork.mainnetWarning')}
                </p>
              )}
              <p className="mt-2">{t('settingsNetwork.switchDetails')}</p>
            </div>
          </div>
        </WalletPopupSheet>
      )}
    </div>
  );
};
