import { useEffect, useId, useRef, useState } from 'react';
import type { TranslationKey } from '../../i18n/resources';
import { useI18n } from '../../i18n/useI18n';
import { copyWithFeedback } from '../../utils/copyWithFeedback';
import WalletPopupSheet from './WalletPopupSheet';

type MaskedValueProps = {
  value: string;
  label: string;
  prefixLength?: number;
  suffixLength?: number;
  copySuccessMessageKey?: TranslationKey;
  className?: string;
  testId?: string;
  ariaLabel?: string;
  embedded?: boolean;
  revealOnClick?: boolean;
  preserveCashAddressPrefix?: boolean;
  maskLength?: number;
};

export default function MaskedValue({
  value,
  label,
  prefixLength = 4,
  suffixLength = 4,
  copySuccessMessageKey = 'receive.copied',
  className = '',
  testId,
  ariaLabel,
  embedded = false,
  revealOnClick = false,
  preserveCashAddressPrefix = false,
  maskLength,
}: MaskedValueProps) {
  const { t } = useI18n();
  const titleId = useId();
  const [showFull, setShowFull] = useState(false);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | undefined>();
  const longPressTriggered = useRef(false);

  useEffect(() => {
    return () => {
      if (longPressTimer.current) clearTimeout(longPressTimer.current);
    };
  }, []);

  if (!value) return null;

  const cashAddressPrefix = preserveCashAddressPrefix
    ? value.match(/^(bitcoincash:|bchtest:)/)?.[0] ?? ''
    : '';
  const visiblePrefixLength = cashAddressPrefix.length + prefixLength;
  const hasMask = value.length > visiblePrefixLength + suffixLength;
  const masked = hasMask ? (
    <span className="flex min-w-0 max-w-full items-center overflow-hidden whitespace-nowrap">
      <span data-mask-part="prefix" className="shrink-0">
        {value.slice(0, visiblePrefixLength)}
      </span>
      <span
        data-mask-part="middle"
        className="min-w-0 flex-1 overflow-hidden px-0.5 text-center tracking-[0.18em]"
      >
        {'*'.repeat(
          maskLength ??
            Math.max(4, value.length - visiblePrefixLength - suffixLength)
        )}
      </span>
      <span data-mask-part="suffix" className="shrink-0">
        {value.slice(-suffixLength)}
      </span>
    </span>
  ) : (
    value
  );

  const openFullValue = () => setShowFull(true);
  const beginLongPress = () => {
    longPressTriggered.current = false;
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
    longPressTimer.current = setTimeout(() => {
      longPressTriggered.current = true;
      openFullValue();
    }, 500);
  };
  const endLongPress = () => {
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
    longPressTimer.current = undefined;
  };

  const copyValue = () => {
    void copyWithFeedback(value, copySuccessMessageKey);
  };

  const handleClick = (event: React.MouseEvent) => {
    if (embedded) event.stopPropagation();
    if (longPressTriggered.current) {
      longPressTriggered.current = false;
      return;
    }
    if (revealOnClick) {
      openFullValue();
      return;
    }
    copyValue();
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    event.stopPropagation();
    if (revealOnClick) {
      openFullValue();
      return;
    }
    copyValue();
  };

  const handleContextMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    if (embedded) event.stopPropagation();
    longPressTriggered.current = true;
    openFullValue();
  };

  const triggerClassName =
    `${embedded ? 'inline-flex items-center' : ''} min-h-[44px] min-w-0 text-left font-mono text-sm underline decoration-[var(--wallet-border)] underline-offset-4 ${className}`.trim();
  const triggerProps = {
    'aria-label': ariaLabel ?? label,
    'data-testid': testId,
    onClick: handleClick,
    onKeyDown: handleKeyDown,
    onContextMenu: handleContextMenu,
    onPointerDown: beginLongPress,
    onPointerUp: endLongPress,
    onPointerCancel: endLongPress,
    onPointerLeave: endLongPress,
  };

  return (
    <>
      {embedded ? (
        <span
          role="button"
          tabIndex={0}
          className={triggerClassName}
          {...triggerProps}
        >
          {masked}
        </span>
      ) : (
        <button type="button" className={triggerClassName} {...triggerProps}>
          {masked}
        </button>
      )}

      {showFull ? (
        <WalletPopupSheet
          ariaLabelledBy={titleId}
          onDismiss={() => setShowFull(false)}
          dismissLabel={t('app.close')}
          footer={
            <div className="flex gap-2">
              <button
                type="button"
                className="wallet-btn-secondary flex-1"
                onClick={() => setShowFull(false)}
              >
                {t('app.close')}
              </button>
              <button
                type="button"
                className="wallet-btn-primary flex-1"
                onClick={() =>
                  void copyWithFeedback(value, copySuccessMessageKey)
                }
              >
                {t('send.copy')}
              </button>
            </div>
          }
        >
          <div className="space-y-3">
            <div
              id={titleId}
              className="text-base font-semibold wallet-text-strong"
            >
              {label}
            </div>
            <p className="break-all rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface-strong)] p-3 font-mono text-sm wallet-text-strong">
              {value}
            </p>
          </div>
        </WalletPopupSheet>
      ) : null}
    </>
  );
}
