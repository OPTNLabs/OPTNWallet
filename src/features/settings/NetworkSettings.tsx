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

// To add a new network in future:
//  1. Add its value to the Network enum in networkSlice.ts
//  2. Add its Electrum + infra servers in src/utils/servers/InfraUrls.ts
//  3. Update the network-parsing switch in WalletManager.ts (several spots)
//  4. Add an entry to SUPPORTED_NETWORKS below — UI handles the rest
const SUPPORTED_NETWORKS: {
  id: Network;
  color: string;
}[] = [
  {
    id: Network.MAINNET,
    color: '#22c55e',
  },
  {
    id: Network.CHIPNET,
    color: '#6366f1',
  },
];

export const NetworkSettings: React.FC = () => {
  const navigate = useNavigate();
  const currentNetwork = useSelector(selectCurrentNetwork);
  const walletId = useSelector(selectWalletId);
  const currentPath = useSelector(selectWalletDerivationPath);
  const pathSource = useSelector(selectWalletDerivationPathSource);
  const { t } = useI18n();
  const [switching, setSwitching] = useState(false);

  const handleSwitch = async (target: Network) => {
    if (target === currentNetwork || switching) return;
    setSwitching(true);

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
      console.error('[NetworkSettings] network switch failed:', err);
    } finally {
      setSwitching(false);
    }
  };

  const handleReload = async () => {
    if (switching || walletId <= 0) return;
    setSwitching(true);
    try {
      await reloadActiveWallet(walletId);
    } catch (err) {
      console.error('[NetworkSettings] wallet reload failed:', err);
    } finally {
      setSwitching(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs wallet-muted leading-relaxed">
        {t('settingsNetwork.description')}
      </p>

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
        {SUPPORTED_NETWORKS.map((net) => {
          const isActive = net.id === currentNetwork;
          return (
            <button
              key={net.id}
              type="button"
              onClick={() => void handleSwitch(net.id)}
              disabled={isActive || switching}
              className={`w-full rounded-xl border p-4 text-left transition-colors disabled:cursor-default ${
                isActive
                  ? 'border-[var(--wallet-accent)] bg-[var(--wallet-accent)]/10'
                  : 'border-[var(--wallet-border)] wallet-surface hover:border-[var(--wallet-accent)]/60'
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="flex flex-col gap-0.5">
                  <div className="flex items-center gap-2">
                    <span style={{ color: net.color }} aria-hidden>
                      ●
                    </span>
                    <span className="font-semibold wallet-text-strong">
                      {net.id === Network.MAINNET
                        ? t('settingsNetwork.mainnet')
                        : t('settingsNetwork.chipnet')}
                    </span>
                  </div>
                  <p className="text-xs wallet-muted pl-5">
                    {net.id === Network.MAINNET
                      ? t('settingsNetwork.mainnetDescription')
                      : t('settingsNetwork.chipnetDescription')}
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

        {[
          t('settingsNetwork.testnet3'),
          t('settingsNetwork.testnet4'),
          t('settingsNetwork.regtest'),
        ].map((label) => (
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
    </div>
  );
};
