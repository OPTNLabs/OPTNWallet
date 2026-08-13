import type { ReactNode } from 'react';

type WalletPopupSheetProps = {
  children: ReactNode;
  footer: ReactNode;
  maxWidthClassName?: string;
};

export default function WalletPopupSheet({
  children,
  footer,
  maxWidthClassName = 'max-w-md',
}: WalletPopupSheetProps) {
  return (
    <div className="wallet-popup-backdrop p-3 sm:p-4">
      <div
        className={`wallet-popup-panel ${maxWidthClassName} flex w-full min-w-0 flex-col overflow-hidden`}
        style={{
          maxHeight: 'calc(100dvh - var(--safe-bottom, 0px) - 1rem)',
        }}
      >
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain touch-pan-y pr-1">
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
}
