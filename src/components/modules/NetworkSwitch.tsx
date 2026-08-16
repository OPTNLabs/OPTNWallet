import { Network } from '../../state/slices/networkSlice';
import { useI18n } from '../../i18n/useI18n';

type NetworkSwitchProps = {
  networkType: Network;
  setNetworkType: (network: Network) => void;
};

const NetworkSwitch = ({
  networkType,
  setNetworkType,
}: NetworkSwitchProps) => {
  const { t } = useI18n();
  const handleToggle = () => {
    setNetworkType(
      networkType === Network.CHIPNET ? Network.MAINNET : Network.CHIPNET
    );
  };

  return (
    <div className="flex flex-row gap-2 items-center wallet-text-strong font-medium">
      <span className="text-base">{t('network.chipnet')}</span>
      <button
        type="button"
        onClick={handleToggle}
        className={`w-12 h-6 rounded-full flex items-center cursor-pointer relative transition-colors border border-[var(--wallet-border)] ${
          networkType === Network.MAINNET
            ? 'bg-[var(--wallet-accent)]'
            : 'wallet-surface-strong'
        }`}
        aria-label={t('network.switch', {
          network:
            networkType === Network.MAINNET
              ? t('network.mainnet')
              : t('network.chipnet'),
        })}
      >
        <div
          className={`w-6 h-6 rounded-full shadow-md transform transition-transform ${
            networkType === Network.MAINNET ? 'translate-x-6' : 'translate-x-0'
          }`}
          style={{ backgroundColor: 'var(--wallet-card-bg)' }}
        />
      </button>
      <span className="text-base">{t('network.mainnet')}</span>
    </div>
  );
};

export default NetworkSwitch;
