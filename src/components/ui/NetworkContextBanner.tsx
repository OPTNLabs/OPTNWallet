import { useI18n } from '../../i18n/useI18n';

type NetworkContextBannerProps = {
  network: string | number;
  description?: string;
  className?: string;
};

function networkCopy(
  network: string | number,
  t: ReturnType<typeof useI18n>['t']
) {
  const normalized = String(network).toLowerCase();
  if (
    normalized === 'chipnet' ||
    normalized === 'testnet' ||
    normalized.includes('chip') ||
    normalized.includes('test')
  ) {
    return {
      label: t('network.chipnet'),
      description: t('settingsNetwork.chipnetDescription'),
      className:
        'border-indigo-400/60 bg-indigo-500/15 text-indigo-950 dark:text-indigo-100',
      marker: t('network.testMarker'),
      activeLabel: t('network.activeLabel', {
        network: t('network.chipnet'),
      }),
    };
  }

  return {
    label: t('network.mainnet'),
    description: t('settingsNetwork.mainnetDescription'),
    className:
      'border-emerald-500/70 bg-emerald-500/15 text-emerald-950 dark:text-emerald-100',
    marker: t('network.liveMarker'),
    activeLabel: t('network.activeLabel', {
      network: t('network.mainnet'),
    }),
  };
}

export default function NetworkContextBanner({
  network,
  description,
  className = '',
}: NetworkContextBannerProps) {
  const { t } = useI18n();
  const copy = networkCopy(network, t);

  return (
    <div
      role="region"
      aria-label={copy.activeLabel}
      className={`network-context-banner flex min-h-[52px] items-center justify-center gap-3 rounded-2xl border px-3 py-2.5 text-center ${copy.className} ${className}`.trim()}
    >
      <span
        aria-hidden="true"
        className="flex h-8 min-w-8 items-center justify-center rounded-full border border-current/30 px-1.5 text-[10px] font-bold tracking-[0.12em]"
      >
        {copy.marker}
      </span>
      <span className="min-w-0">
        <span className="block text-xs font-bold tracking-[0.14em]">
          {copy.label}
        </span>
        <span className="block text-xs opacity-80">
          {description ?? copy.description}
        </span>
      </span>
    </div>
  );
}
