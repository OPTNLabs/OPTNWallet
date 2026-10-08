import { Network } from '../../state/slices/networkSlice';
import { useI18n } from '../../i18n/useI18n';
import {
  networkProfile,
  SELECTABLE_NETWORKS,
} from '../../utils/networkProfile';

type NetworkSwitchProps = {
  networkType: Network;
  setNetworkType: (network: Network) => void;
};

/** One choice per selectable network; the list comes from the network profiles. */
const NetworkSwitch = ({ networkType, setNetworkType }: NetworkSwitchProps) => {
  const { t } = useI18n();

  return (
    <div
      role="radiogroup"
      aria-label={t('settings.network')}
      className="flex flex-row flex-wrap gap-2 items-center wallet-text-strong font-medium"
    >
      {SELECTABLE_NETWORKS.map((network) => {
        const profile = networkProfile(network);
        const active = network === networkType;
        return (
          <button
            key={network}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => setNetworkType(network)}
            className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm transition-colors ${
              active
                ? 'border-[var(--wallet-accent)] bg-[var(--wallet-accent)]/10'
                : 'border-[var(--wallet-border)] wallet-surface hover:border-[var(--wallet-accent)]/60'
            }`}
          >
            <span style={{ color: profile.color }} aria-hidden>
              ●
            </span>
            {t(profile.labelKey)}
          </button>
        );
      })}
    </div>
  );
};

export default NetworkSwitch;
