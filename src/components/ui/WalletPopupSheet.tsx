import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

type WalletPopupSheetProps = {
  children: ReactNode;
  footer: ReactNode;
  maxWidthClassName?: string;
  onDismiss?: () => void;
};

export default function WalletPopupSheet({
  children,
  footer,
  maxWidthClassName = 'max-w-md',
  onDismiss,
}: WalletPopupSheetProps) {
  useEffect(() => {
    if (!onDismiss) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onDismiss();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onDismiss]);

  const sheet = (
    <div
      className="wallet-popup-backdrop z-[1300] p-3 sm:p-4"
      onClick={onDismiss}
      role="presentation"
    >
      <div
        className={`wallet-popup-panel ${maxWidthClassName} flex w-full min-w-0 flex-col overflow-hidden`}
        style={{
          maxHeight: 'calc(100dvh - var(--safe-bottom, 0px) - 1.5rem)',
        }}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        {onDismiss ? (
          <div className="mb-2 flex justify-end shrink-0">
            <button
              type="button"
              className="wallet-btn-secondary px-3 py-1.5 text-sm"
              onClick={onDismiss}
              aria-label="Close"
            >
              Close
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
