import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

type WalletPopupSheetProps = {
  children: ReactNode;
  footer: ReactNode;
  maxWidthClassName?: string;
  onDismiss?: () => void;
  dismissLabel?: string;
  showDismissButton?: boolean;
  ariaLabelledBy?: string;
};

export default function WalletPopupSheet({
  children,
  footer,
  maxWidthClassName = 'max-w-md',
  onDismiss,
  dismissLabel = 'Close',
  showDismissButton = true,
  ariaLabelledBy,
}: WalletPopupSheetProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const onDismissRef = useRef(onDismiss);

  useEffect(() => {
    onDismissRef.current = onDismiss;
  }, [onDismiss]);

  useEffect(() => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const panel = panelRef.current;
    const focusableSelector =
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const getFocusable = () =>
      panel
        ? Array.from(panel.querySelectorAll<HTMLElement>(focusableSelector))
        : [];
    (getFocusable()[0] ?? panel)?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (onDismissRef.current) {
          event.preventDefault();
          onDismissRef.current();
        }
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = getFocusable();
      if (!focusable.length) {
        event.preventDefault();
        panel?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (
        event.shiftKey &&
        (document.activeElement === first ||
          !panel?.contains(document.activeElement))
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last ||
          !panel?.contains(document.activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, []);

  const sheet = (
    <div
      className="wallet-popup-backdrop z-[1300] p-3 sm:p-4"
      onClick={onDismiss}
      role="presentation"
    >
      <div
        ref={panelRef}
        className={`wallet-popup-panel ${maxWidthClassName} flex w-full min-w-0 flex-col overflow-hidden`}
        tabIndex={-1}
        style={{
          maxHeight: 'calc(100dvh - var(--safe-bottom, 0px) - 1.5rem)',
        }}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={ariaLabelledBy}
      >
        {onDismiss && showDismissButton ? (
          <div className="mb-2 flex justify-end shrink-0">
            <button
              type="button"
              className="wallet-btn-secondary px-3 py-1.5 text-sm"
              onClick={onDismiss}
              aria-label={dismissLabel}
            >
              {dismissLabel}
            </button>
          </div>
        ) : null}
        <div className="min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain touch-pan-y pr-1">
          {children}
        </div>
        <div
          className="mt-4 shrink-0 pt-3"
          style={{ borderTop: '1px solid var(--wallet-border)' }}
        >
          {footer}
        </div>
      </div>
    </div>
  );

  if (typeof document === 'undefined' || !document.body) {
    return sheet;
  }
  return createPortal(sheet, document.body);
}
