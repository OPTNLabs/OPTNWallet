import { useI18n } from '../../i18n/useI18n';

export type BchUsdUnit = 'bch' | 'usd';

type BchUsdControlProps = {
  value: BchUsdUnit;
  onChange: (value: BchUsdUnit) => void;
  disabled?: boolean;
  className?: string;
};

export default function BchUsdControl({
  value,
  onChange,
  disabled = false,
  className = '',
}: BchUsdControlProps) {
  const { t } = useI18n();

  return (
    <div
      role="group"
      aria-label={t('send.amountUnit')}
      className={`grid grid-cols-2 gap-1 rounded-2xl border border-[var(--wallet-border)] bg-[var(--wallet-surface-strong)] p-1 ${className}`.trim()}
    >
      {(['bch', 'usd'] as const).map((unit) => {
        const active = value === unit;
        const label = unit === 'bch' ? 'BCH' : 'USD';
        return (
          <button
            key={unit}
            type="button"
            aria-pressed={active}
            disabled={disabled}
            className={`min-h-[44px] rounded-xl px-3 py-2 text-sm font-semibold transition ${
              active
                ? 'wallet-segment-active border border-[var(--wallet-accent)]'
                : 'wallet-segment-inactive border border-transparent'
            }`}
            onClick={() => onChange(unit)}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
