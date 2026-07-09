import type { CSSProperties } from 'react';

import { sanitizeDecimalInput } from '../../../services/cauldron/amount';

type MerchantAmountPadProps = {
  amount: string;
  decimals: number;
  symbol: string;
  disabled?: boolean;
  onChange: (next: string) => void;
  onClear?: () => void;
  className?: string;
  showHint?: boolean;
};

const keypad = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
  ['.', '0', '⌫'],
] as const;

const keyStyle: CSSProperties = {
  backgroundColor: 'var(--wallet-surface-strong)',
  borderColor: 'var(--wallet-border)',
  boxShadow: 'var(--wallet-shadow-card)',
};

function applyKey(current: string, key: string, decimals: number): string {
  if (key === 'Del' || key === '⌫') {
    const next = current.slice(0, -1);
    return next ? sanitizeDecimalInput(next, decimals) : '';
  }

  if (key === '.') {
    if (current.includes('.')) return current;
    return sanitizeDecimalInput(current ? `${current}.` : '0.', decimals);
  }

  const next = sanitizeDecimalInput(`${current}${key}`, decimals);
  return next === '0' && key === '0' && !current.includes('.')
    ? current || '0'
    : next;
}

export default function MerchantAmountPad({
  amount,
  decimals,
  symbol,
  disabled = false,
  onChange,
  onClear,
  className = '',
  showHint = true,
}: MerchantAmountPadProps) {
  const displayValue = amount.trim() || '0';

  return (
    <div className={`flex h-full min-h-0 flex-col gap-2 ${className}`.trim()}>
      <div
        className="shrink-0 rounded-[24px] border px-3 py-2.5"
        style={{
          background:
            'linear-gradient(180deg, color-mix(in oklab, var(--wallet-surface-strong) 92%, #ffffff 8%) 0%, var(--wallet-surface-strong) 100%)',
          borderColor: 'var(--wallet-border)',
          boxShadow: 'var(--wallet-shadow-card)',
        }}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-[0.22em] wallet-muted opacity-70">
              Amount to receive
            </div>
            <div className="mt-1 break-words text-[clamp(2.2rem,8vw,3.5rem)] font-black leading-none tracking-tight wallet-text-strong">
              {displayValue}
            </div>
            {showHint ? (
              <p className="mt-1 text-xs leading-5 wallet-muted">
                Enter the stablecoin amount you want to receive.
              </p>
            ) : null}
          </div>

          <div className="flex shrink-0 flex-col items-end gap-2">
            <div
              className="rounded-full border px-2.5 py-1 text-xs font-semibold wallet-text-strong"
              style={keyStyle}
            >
              {symbol}
            </div>
            <button
              type="button"
              onClick={() => {
                if (onClear) {
                  onClear();
                } else {
                  onChange('');
                }
              }}
              className="rounded-full border px-2.5 py-1 text-[11px] font-semibold wallet-text-strong transition"
              style={keyStyle}
              disabled={disabled}
            >
              Clear
            </button>
          </div>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-3 grid-rows-4 gap-2">
        {keypad.flat().map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => onChange(applyKey(amount, key, decimals))}
            className="flex h-full min-h-0 items-center justify-center rounded-3xl border px-2 py-0 text-2xl font-bold leading-none wallet-text-strong transition sm:text-[1.75rem]"
            style={keyStyle}
            disabled={disabled || (key === '.' && decimals === 0)}
          >
            {key}
          </button>
        ))}
      </div>
    </div>
  );
}
