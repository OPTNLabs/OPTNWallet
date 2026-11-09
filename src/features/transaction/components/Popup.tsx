// src/components/transaction/Popup.tsx

import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

interface PopupProps {
  closePopups: () => void;
  children: React.ReactNode;
  closeButtonText?: string;
  closeButtonClassName?: string;
  ariaLabel?: string;
}

const Popup: React.FC<PopupProps> = ({
  closePopups,
  children,
  closeButtonText = 'Close',
  closeButtonClassName = 'wallet-btn-secondary w-full my-2',
  ariaLabel,
}) => {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const closePopupsRef = useRef(closePopups);

  useEffect(() => {
    closePopupsRef.current = closePopups;
  }, [closePopups]);

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

    (getFocusable()[0] ?? closeButtonRef.current)?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closePopupsRef.current();
        return;
      }

      if (event.key !== 'Tab') return;
      const focusable = getFocusable();
      if (focusable.length === 0) {
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

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, []);

  const popup = (
    <div
      className="wallet-popup-backdrop z-[1200] p-3 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      style={{
        paddingBottom:
          'calc(max(var(--navbar-height), 5.5rem) + var(--safe-bottom) + 0.75rem)',
      }}
    >
      <div
        ref={panelRef}
        className="wallet-popup-panel flex w-full max-w-md min-w-0 flex-col overflow-hidden overflow-x-hidden"
        tabIndex={-1}
        style={{
          maxHeight:
            'calc(100dvh - max(var(--navbar-height), 5.5rem) - var(--safe-bottom) - 1rem)',
        }}
      >
        <div className="min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain touch-pan-y pr-1">
          {children}
        </div>
        <div
          className="flex justify-center mt-4 pt-3 shrink-0"
          style={{ borderTop: '1px solid var(--wallet-border)' }}
        >
          <button
            ref={closeButtonRef}
            type="button"
            className={closeButtonClassName}
            onClick={closePopups}
          >
            {closeButtonText}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(popup, document.body);
};

export default Popup;
