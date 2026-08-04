import React, { useEffect, useState } from 'react';
import { formatNumber } from '../i18n/format';
import { useI18n } from '../i18n/useI18n';
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
      error: 'derivation.invalidActive',
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
  const { t, locale } = useI18n();
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
      setError('derivation.invalidActive');
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
        t('derivation.required', {
          field: t(
            field === 'coinType'
              ? 'derivation.coinType'
              : 'derivation.accountIndex'
          ),
        })
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
          : t('derivation.invalidValues')
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
            {t('derivation.pathPreview')}
          </span>
          <code className="text-sm font-semibold wallet-text-strong">
            m/44&apos;/{coinType || '—'}&apos;/{accountIndex || '—'}&apos;
          </code>
        </div>
        <p className="mt-1 text-[11px] wallet-muted">
          {t('derivation.pathDescription')}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-semibold wallet-text-strong">
            {t('derivation.coinType')}
          </span>
          <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            value={coinType}
            onChange={(event) => updateField('coinType', event.target.value)}
            className="wallet-input w-full rounded-lg px-3 py-2.5 text-base wallet-text-strong"
            aria-label={t('derivation.bip44CoinType')}
            disabled={disabled}
          />
          <span className="text-[11px] wallet-muted">
            {t('derivation.networkDefault', { value: defaultCoinType })}
          </span>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-semibold wallet-text-strong">
            {t('derivation.accountIndex')}
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
            aria-label={t('derivation.bip44AccountIndex')}
            disabled={disabled}
          />
          <span className="text-[11px] wallet-muted">
            {t('derivation.usuallyZero')}
          </span>
        </label>
      </div>

      <p className="text-xs leading-relaxed wallet-muted">
        {t('derivation.branchDescription')}
      </p>
      {error && (
        <p className="text-xs text-red-400">
          {error === 'derivation.invalidActive'
            ? t('derivation.invalidActive')
            : error}
        </p>
      )}
      <p className="text-[11px] wallet-muted">
        {t('derivation.range', {
          max: formatNumber(MAX_BIP44_INDEX, locale),
        })}
      </p>
    </div>
  );
};

export default Bip44AccountPathFields;
