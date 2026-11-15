import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MdInfoOutline } from 'react-icons/md';

type InfoButtonProps = {
  content: string;
  ariaLabel: string;
  id?: string;
  /** Align the popover toward the available side of its trigger. */
  popoverSide?: 'left' | 'right' | 'center';
};

export default function InfoButton({
  content,
  ariaLabel,
  id,
  popoverSide = 'left',
}: InfoButtonProps) {
  const generatedId = useId();
  const contentId = `${id ?? generatedId}-info`;
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | undefined>();
  const longPressTriggered = useRef(false);

  useEffect(() => {
    return () => {
      if (longPressTimer.current) clearTimeout(longPressTimer.current);
    };
  }, []);

  const beginLongPress = () => {
    longPressTriggered.current = false;
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
    longPressTimer.current = setTimeout(() => {
      longPressTriggered.current = true;
      setOpen(true);
    }, 500);
  };

  const endLongPress = () => {
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
    longPressTimer.current = undefined;
  };

  return (
    <span className="relative inline-flex min-h-[44px] min-w-[44px] items-center justify-center">
      <button
        ref={buttonRef}
        type="button"
        className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--wallet-focus-ring)]"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls={contentId}
        aria-describedby={open ? contentId : undefined}
        onClick={() => {
          if (longPressTriggered.current) {
            longPressTriggered.current = false;
            return;
          }
          setOpen((visible) => !visible);
        }}
        onPointerDown={beginLongPress}
        onPointerUp={endLongPress}
        onPointerCancel={endLongPress}
        onPointerLeave={endLongPress}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            setOpen(false);
          }
        }}
      >
        <MdInfoOutline
          aria-hidden="true"
          className="text-lg font-bold wallet-accent-icon"
        />
      </button>
      {open
        ? (() => {
            const popover = (
              <span
                id={contentId}
                role="note"
                className={`${
                  popoverSide === 'center'
                    ? 'fixed left-1/2 top-1/2 z-[1300] -translate-x-1/2 -translate-y-1/2'
                    : `absolute ${
                        popoverSide === 'right'
                          ? 'left-0 right-auto'
                          : 'right-0'
                      } top-full z-50 mt-1`
                } w-[min(18rem,calc(100vw-2rem))] max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-xl border border-[var(--wallet-border)] p-3 text-left text-sm leading-snug wallet-text-strong shadow-2xl`}
                style={{
                  backgroundColor: 'var(--wallet-surface)',
                  opacity: 1,
                  isolation: 'isolate',
                }}
              >
                {content}
              </span>
            );

            return popoverSide === 'center' && typeof document !== 'undefined'
              ? createPortal(popover, document.body)
              : popover;
          })()
        : null}
    </span>
  );
}
