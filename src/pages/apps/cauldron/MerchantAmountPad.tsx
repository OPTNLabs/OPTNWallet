import type { CSSProperties } from 'react';

import { sanitizeDecimalInput } from '../../../services/cauldron/amount';

type MerchantAmountPadProps = {
  amount: string;
  decimals: number;
  symbol: string;
  disabled?: boolean;
  onChange: (next: string) => void;
  onClear?: () => void;
};

const keypad = [
  ['7', '8', '9'],
  ['4', '5', '6'],
  ['1', '2', '3'],
  ['.', '0', '⌫'],
] as const;

const keyStyle: CSSProperties = {
  backgroundColor: 'var(--wallet-surface-strong)',
  borderColor: 'var(--wallet-border)',
  boxShadow: 'var(--wallet-shadow-card)',
};

function applyKey(
  current: string,
  key: string,
  decimals: number
): string {
  if (key === '⌫') {
    const next = current.slice(0, -1);
    return next ? sanitizeDecimalInput(next, decimals) : '';
  }

  if (key === '.') {
    if (current.includes('.')) return current;
    return sanitizeDecimalInput(current ? `${current}.` : '0.', decimals);
  }

  const next = sanitizeDecimalInput(`${current}${key}`, decimals);
  return next === '0' && key === '0' && !current.includes('.') ? current || '0' : next;
}

export default function MerchantAmountPad({
  amount,
  decimals,
  symbol,
  disabled = false,
  onChange,
  onClear,
}: MerchantAmountPadProps) {
  const displayValue = amount || '0';

  return (
    <div className="space-y-3">
      <div
        className="rounded-[28px] border px-4 py-4"
        style={{
          backgroundColor: 'var(--wallet-surface-strong)',
          borderColor: 'var(--wallet-border)',
        }}
      >
        <div className="text-[11px] uppercase tracking-[0.2em] wallet-muted opacity-70">
          Amount to receive
        </div>
        <div className="mt-2 flex items-end justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-4xl font-black leading-none tracking-tight wallet-text-strong sm:text-5xl">
              {displayValue}
            </div>
            <div className="mt-2 text-xs wallet-muted">
              Use the keypad to enter the stablecoin amount.
            </div>
          </div>
          <div className="shrink-0 rounded-full border px-3 py-1 text-sm font-semibold wallet-text-strong"
               style={keyStyle}>
            {symbol}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <button
          type="button"
          onClick={() => {
            if (onClear) {
              onClear();
            } else {
              onChange('');
            }
          }}
          className="rounded-2xl border px-3 py-3 text-sm font-semibold wallet-text-strong transition"
          style={keyStyle}
          disabled={disabled}
        >
          Clear
        </button>
        <div />
        <div />
      </div>

      <div className="grid grid-cols-3 gap-2">
        {keypad.flat().map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => onChange(applyKey(amount, key, decimals))}
            className="rounded-3xl border px-3 py-5 text-center text-2xl font-bold leading-none wallet-text-strong transition sm:py-6 sm:text-3xl"
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
