import React, { useEffect, useState } from 'react';
import { Network } from '../state/slices/networkSlice';
import {
  buildBchAccountPath,
  getBchCoinType,
  getBchAccountPath,
  MAX_BIP44_INDEX,
  parseBchAccountPath,
} from '../services/HdWalletService';

type Bip44AccountPathFieldsProps = {
  network: Network;
  value: string;
  onChange: (path: string) => void;
  onValidityChange?: (valid: boolean) => void;
  disabled?: boolean;
};

type FieldName = 'coinType' | 'accountIndex';

function initialParts(value: string, network: Network) {
  try {
    return { parts: parseBchAccountPath(value), error: null };
  } catch {
    return {
      parts: parseBchAccountPath(getBchAccountPath(network)),
      error: 'The active derivation path is invalid.',
    };
  }
}

const Bip44AccountPathFields: React.FC<Bip44AccountPathFieldsProps> = ({
  network,
  value,
  onChange,
  onValidityChange,
  disabled = false,
}) => {
  const initial = initialParts(value, network);
  const [coinType, setCoinType] = useState(String(initial.parts.coinType));
  const [accountIndex, setAccountIndex] = useState(
    String(initial.parts.accountIndex)
  );
  const [error, setError] = useState<string | null>(initial.error);

  useEffect(() => {
    try {
      const parts = parseBchAccountPath(value);
      setCoinType(String(parts.coinType));
      setAccountIndex(String(parts.accountIndex));
      setError(null);
      onValidityChange?.(true);
    } catch {
      const fallback = parseBchAccountPath(getBchAccountPath(network));
      setCoinType(String(fallback.coinType));
      setAccountIndex(String(fallback.accountIndex));
      setError('The active derivation path is invalid.');
      onValidityChange?.(false);
    }
  }, [network, onValidityChange, value]);

  const updateField = (field: FieldName, rawValue: string) => {
    const nextValue = rawValue.replace(/[^0-9]/g, '');
    const nextCoinType = field === 'coinType' ? nextValue : coinType;
    const nextAccountIndex =
      field === 'accountIndex' ? nextValue : accountIndex;

    if (field === 'coinType') setCoinType(nextValue);
    else setAccountIndex(nextValue);

    if (!nextValue) {
      setError(
        `${field === 'coinType' ? 'Coin type' : 'Account index'} is required.`
      );
      onValidityChange?.(false);
      return;
    }

    if (!nextCoinType || !nextAccountIndex) {
      onValidityChange?.(false);
      return;
    }

    try {
      const path = buildBchAccountPath({
        coinType: Number(nextCoinType),
        accountIndex: Number(nextAccountIndex),
      });
      onChange(path);
      setError(null);
      onValidityChange?.(true);
    } catch (validationError) {
      setError(
        validationError instanceof Error
          ? validationError.message
          : 'Invalid BIP44 path values.'
      );
      onValidityChange?.(false);
    }
  };

  const defaultCoinType = getBchCoinType(network);

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-[var(--wallet-border)] wallet-surface-strong px-3 py-2.5">
        <div className="flex items-center justify-between gap-3">
          <span className="text-[11px] font-semibold uppercase tracking-wide wallet-muted">
            Path preview
          </span>
          <code className="text-sm font-semibold wallet-text-strong">
            m/44&apos;/{coinType || '—'}&apos;/{accountIndex || '—'}&apos;
          </code>
        </div>
        <p className="mt-1 text-[11px] wallet-muted">
          The fixed BIP44 account path used by this wallet.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-semibold wallet-text-strong">
            Coin type
          </span>
          <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            value={coinType}
            onChange={(event) => updateField('coinType', event.target.value)}
            className="wallet-input w-full rounded-lg px-3 py-2.5 text-base wallet-text-strong"
            aria-label="BIP44 coin type"
            disabled={disabled}
          />
          <span className="text-[11px] wallet-muted">
            Network default: {defaultCoinType}
          </span>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-semibold wallet-text-strong">
            Account index
          </span>
          <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            value={accountIndex}
            onChange={(event) =>
              updateField('accountIndex', event.target.value)
            }
            className="wallet-input w-full rounded-lg px-3 py-2.5 text-base wallet-text-strong"
            aria-label="BIP44 account index"
            disabled={disabled}
          />
          <span className="text-[11px] wallet-muted">Usually 0</span>
        </label>
      </div>

      <p className="text-xs leading-relaxed wallet-muted">
        Hardened markers are fixed. Receive and change addresses are derived
        automatically from the <code>/0/index</code> and <code>/1/index</code>{' '}
        branches.
      </p>
      {error && <p className="text-xs text-red-400">{error}</p>}
      <p className="text-[11px] wallet-muted">
        Enter whole numbers from 0 to {MAX_BIP44_INDEX.toLocaleString()}.
      </p>
    </div>
  );
};

export default Bip44AccountPathFields;
