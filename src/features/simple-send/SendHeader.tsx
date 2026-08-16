import React from 'react';
import { Link } from 'react-router-dom';
import { useI18n } from '../../i18n/useI18n';

type SendHeaderProps = {
  showDebug: boolean;
  setShowDebug: React.Dispatch<React.SetStateAction<boolean>>;
};

export function SendHeader({ showDebug, setShowDebug }: SendHeaderProps) {
  const { t } = useI18n();

  return (
    <div className="mb-3 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] wallet-muted">
          OPTN Wallet
        </div>
        <h1 className="text-2xl font-extrabold wallet-text-strong leading-tight">
          {t('send.title')}
        </h1>
        <p className="text-sm wallet-muted">{t('send.guidedDescription')}</p>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <label className="flex items-center gap-2 text-xs font-semibold wallet-muted select-none">
          <input
            type="checkbox"
            className="w-4 h-4"
            style={{ accentColor: 'var(--wallet-accent-strong)' }}
            checked={showDebug}
            onChange={(e) => setShowDebug(e.target.checked)}
          />
          {t('send.debug')}
        </label>

        <Link
          to="/transaction"
          className="text-sm font-semibold wallet-text-strong underline underline-offset-4"
          title={t('send.advancedBuilder')}
        >
          {t('send.advanced')}
        </Link>
      </div>
    </div>
  );
}
