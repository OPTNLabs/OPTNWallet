import React from 'react';
import { useDispatch, useSelector } from 'react-redux';
import {
  selectRpaEnabled,
  selectQuantumrootEnabled,
  setRpaEnabled,
  setQuantumrootEnabled,
} from '../../state/slices/experimentalSlice';
import { useI18n } from '../../i18n/useI18n';

type FeatureToggleProps = {
  title: string;
  badge?: string;
  description: string;
  warning?: string;
  enabled: boolean;
  onToggle: (v: boolean) => void;
  toggleLabel: string;
};

function FeatureToggle({
  title,
  badge,
  description,
  warning,
  enabled,
  onToggle,
  toggleLabel,
}: FeatureToggleProps) {
  return (
    <div className="rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-semibold wallet-text-strong truncate">
            {title}
          </span>
          {badge && (
            <span className="shrink-0 rounded-full border border-yellow-400/40 bg-yellow-400/10 px-2 py-0.5 text-[10px] font-bold text-yellow-400 uppercase tracking-wide">
              {badge}
            </span>
          )}
        </div>
        <button
          onClick={() => onToggle(!enabled)}
          className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors ${
            enabled
              ? 'bg-[var(--wallet-accent)] border-[var(--wallet-accent)]'
              : 'wallet-surface-strong border-[var(--wallet-border)]'
          }`}
          aria-label={`${toggleLabel} ${title}`}
        >
          <span
            className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${
              enabled ? 'translate-x-5' : 'translate-x-0.5'
            }`}
          />
        </button>
      </div>
      <p className="text-xs wallet-muted leading-relaxed">{description}</p>
      {warning && (
        <p className="text-xs text-yellow-400/90 leading-relaxed">
          ⚠ {warning}
        </p>
      )}
    </div>
  );
}

export const ExperimentalSettings: React.FC = () => {
  const dispatch = useDispatch();
  const { t } = useI18n();
  const rpaEnabled = useSelector(selectRpaEnabled);
  const quantumrootEnabled = useSelector(selectQuantumrootEnabled);

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl border border-yellow-400/20 bg-yellow-400/5 p-3 space-y-1">
        <p className="text-xs font-semibold text-yellow-400">
          {t('experimental.features')}
        </p>
        <p className="text-xs wallet-muted leading-relaxed">
          {t('experimental.description')}
        </p>
      </div>

      <FeatureToggle
        title="Quantumroot"
        badge={t('experimental.quantumSafe')}
        description={t('experimental.quantumDescription')}
        toggleLabel={
          quantumrootEnabled
            ? t('experimental.disable')
            : t('experimental.enable')
        }
        enabled={quantumrootEnabled}
        onToggle={(v) => dispatch(setQuantumrootEnabled(v))}
      />

      <FeatureToggle
        title={t('experimental.rpaTitle')}
        badge={t('experimental.rpaBadge')}
        description={t('experimental.rpaDescription')}
        warning={t('experimental.rpaWarning')}
        toggleLabel={
          rpaEnabled ? t('experimental.disable') : t('experimental.enable')
        }
        enabled={rpaEnabled}
        onToggle={(v) => dispatch(setRpaEnabled(v))}
      />

    </div>
  );
};
