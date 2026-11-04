import React from 'react';
import { useSelector } from 'react-redux';
import { selectCurrentNetwork } from '../../state/selectors/networkSelectors';
import type { RootState } from '../../state/store';
import { useI18n } from '../../i18n/useI18n';

type PageHeaderProps = {
  title: string;
  subtitle?: string;
  compact?: boolean;
  titleAction?: React.ReactNode;
};

const PageHeader: React.FC<PageHeaderProps> = ({
  title,
  compact = false,
  titleAction,
}) => {
  const currentNetwork = useSelector((state: RootState) =>
    selectCurrentNetwork(state)
  );
  const { t } = useI18n();
  const isChipnet = String(currentNetwork).toLowerCase().includes('chip');
  const networkLabel = isChipnet ? t('network.chipnet') : t('network.mainnet');

  return (
    <header className={`w-full ${compact ? 'mb-3' : 'mb-4'}`}>
      <div
        className={`grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 ${compact ? 'mt-1 mb-2' : 'mt-2 mb-3'}`}
      >
        <div className="min-w-0">
          <h1
            className="break-words text-left text-lg font-bold leading-tight tracking-[-0.02em] wallet-text-strong"
            title={title}
          >
            {title}
          </h1>
        </div>
        <img
          src="/assets/images/OPTNWelcome1.png"
          alt="OPTN"
          className={`wallet-page-header-logo ${compact ? 'w-32 sm:w-44' : 'w-44 sm:w-56'} h-auto opacity-95`}
        />
        <div className="flex min-w-0 items-center justify-end gap-2 text-right">
          <span
            className={`inline-flex min-h-7 items-center rounded-full border px-2.5 text-[10px] font-bold tracking-[0.12em] ${
              isChipnet
                ? 'border-indigo-400/70 bg-indigo-500/15 text-indigo-950 dark:text-indigo-100'
                : 'border-emerald-500/70 bg-emerald-500/15 text-emerald-950 dark:text-emerald-100'
            }`}
            aria-label={`Active network: ${networkLabel}`}
          >
            {networkLabel}
          </span>
          <div className="flex min-w-0 flex-col items-end gap-1">
            {titleAction}
          </div>
        </div>
      </div>
    </header>
  );
};

export default PageHeader;
