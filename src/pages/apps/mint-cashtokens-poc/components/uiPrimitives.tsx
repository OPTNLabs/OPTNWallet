import React, {
  memo,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import Draggable from 'react-draggable';
import { createPortal } from 'react-dom';
import { AddonI18nContext } from '../../../../i18n/AddonI18nContext';

export const Badge: React.FC<{
  children: React.ReactNode;
  tone?: 'gray' | 'blue' | 'green' | 'amber';
}> = memo(({ children, tone = 'gray' }) => {
  const cls =
    tone === 'blue'
      ? 'bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300'
      : tone === 'green'
        ? 'wallet-surface-strong wallet-text-strong'
        : tone === 'amber'
          ? 'bg-amber-50 dark:bg-amber-950/30 text-amber-800 dark:text-amber-300'
          : 'wallet-surface-strong wallet-muted';
  return (
    <span
      className={`px-2 py-0.5 rounded-full text-[11px] font-semibold tracking-tight ${cls}`}
    >
      {children}
    </span>
  );
});

export const PillButton: React.FC<{
  children: React.ReactNode;
  active?: boolean;
  onClick?: () => void;
  disabled?: boolean;
}> = memo(({ children, active, onClick, disabled }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    className={`px-3 py-2 rounded-xl text-sm font-semibold transition ${
      disabled
        ? 'wallet-btn-secondary opacity-60 cursor-not-allowed'
        : active
          ? 'wallet-segment-active'
          : 'wallet-segment-inactive'
    }`}
  >
    {children}
  </button>
));

export const CardShell: React.FC<{
  title: React.ReactNode;
  right?: React.ReactNode;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
  open: boolean;
  onToggle: () => void;
  collapsible?: boolean;
}> = memo(
  ({
    title,
    right,
    subtitle,
    children,
    open,
    onToggle,
    collapsible = true,
  }) => (
    <div className="wallet-card rounded-[20px] shadow-[0_6px_18px_rgba(0,0,0,0.06)] overflow-hidden">
      <button
        type="button"
        className={`w-full px-5 py-4 flex flex-col gap-3 text-left sm:flex-row sm:items-start sm:justify-between ${
          collapsible ? 'cursor-pointer' : 'cursor-default'
        }`}
        onClick={collapsible ? onToggle : undefined}
      >
        <div className="min-w-0 flex-1 text-left">
          <div className="flex items-center gap-2">
            <div className="text-base font-semibold">{title}</div>
          </div>
          {subtitle ? (
            <div className="mt-1 text-sm wallet-muted leading-snug">
              {subtitle}
            </div>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
          {right}
          {collapsible ? (
            <div className="wallet-muted text-sm font-bold w-5 text-right">
              {open ? '−' : '+'}
            </div>
          ) : null}
        </div>
      </button>

      {open ? <div className="px-4 pb-4">{children}</div> : null}
    </div>
  )
);

export const Stepper: React.FC<{
  step: 1 | 2 | 3;
  canGoTo: (n: 1 | 2 | 3) => boolean;
  onStep: (n: 1 | 2 | 3) => void;
}> = memo(({ step, canGoTo, onStep }) => {
  const items: Array<{ n: 1 | 2 | 3; label: string }> = [
    { n: 1, label: 'Mint' },
    { n: 2, label: 'Recipients' },
    { n: 3, label: 'Amounts' },
  ];

  return (
    <div className="relative wallet-surface-strong rounded-2xl p-1 flex">
      {items.map((item) => {
        const active = item.n === step;
        const enabled = canGoTo(item.n);

        return (
          <button
            key={item.n}
            type="button"
            disabled={!enabled}
            onClick={() => enabled && onStep(item.n)}
            className={`relative z-10 flex-1 py-2 text-sm font-semibold rounded-xl transition-all duration-200 ${
              active
                ? 'wallet-text-strong'
                : enabled
                  ? 'wallet-muted'
                  : 'text-gray-400 dark:text-gray-600'
            }`}
          >
            {item.label}
          </button>
        );
      })}

      <div
        className="absolute top-1 bottom-1 w-1/3 wallet-card rounded-xl shadow transition-all duration-300"
        style={{
          transform:
            step === 1
              ? 'translateX(0%)'
              : step === 2
                ? 'translateX(100%)'
                : 'translateX(200%)',
        }}
      />
    </div>
  );
});

export const QuickChip: React.FC<{ label: string; onClick: () => void }> = memo(
  ({ label, onClick }) => (
    <button
      type="button"
      onClick={onClick}
      className="px-2.5 py-1 rounded-full wallet-surface-strong wallet-text-strong text-xs font-semibold active:scale-[0.99]"
    >
      {label}
    </button>
  )
);

export const ContainedSwipeConfirmModal: React.FC<{
  open: boolean;
  title: string;
  subtitle?: string;
  warning?: React.ReactNode;
  loading?: boolean;
  canConfirm?: boolean;
  confirmationMode?: 'slide' | 'button';
  confirmationLabel?: string;
  onCancel: () => void;
  onConfirm: () => void;
  children?: React.ReactNode;
}> = ({
  open,
  title,
  subtitle,
  warning,
  loading = false,
  canConfirm = true,
  confirmationMode = 'slide',
  confirmationLabel = 'Confirm',
  onCancel,
  onConfirm,
  children,
}) => {
  const addonI18n = useContext(AddonI18nContext);
  const cancelLabel = addonI18n?.t('common.cancel', 'Cancel') ?? 'Cancel';
  const defaultWarning = 'Review the details before confirming.';
  const HANDLE_SIZE = 56;
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const onCancelRef = useRef(onCancel);
  const loadingRef = useRef(loading);
  const confirmedRef = useRef(false);
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragX, setDragX] = useState(0);
  const [maxX, setMaxX] = useState(0);
  const [slideCompleted, setSlideCompleted] = useState(false);

  onCancelRef.current = onCancel;
  loadingRef.current = loading;

  useEffect(() => {
    if (!open) return;
    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const dialog = dialogRef.current;
    const getFocusable = () =>
      Array.from(
        dialog?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        ) ?? []
      ).filter((element) => !element.closest('[hidden]'));
    closeButtonRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (!loadingRef.current) {
          event.preventDefault();
          onCancelRef.current();
        }
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = getFocusable();
      if (!focusable.length) {
        event.preventDefault();
        dialog?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!dialog?.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previousFocus?.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      setDragX(0);
      setSlideCompleted(false);
      setMaxX(0);
      confirmedRef.current = false;
    }
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;

    const updateMaxX = () => {
      const width = trackRef.current?.offsetWidth ?? 0;
      setMaxX(Math.max(0, width - HANDLE_SIZE));
    };

    updateMaxX();

    const track = trackRef.current;
    if (!track || typeof ResizeObserver === 'undefined') return;

    const resizeObserver = new ResizeObserver(() => updateMaxX());
    resizeObserver.observe(track);
    window.addEventListener('resize', updateMaxX);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', updateMaxX);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const prevBodyOverflow = document.body.style.overflow;
    const prevHtmlOverflow = document.documentElement.style.overflow;
    const prevBodyTouch = document.body.style.touchAction;

    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
    document.body.style.touchAction = 'none';

    return () => {
      document.body.style.overflow = prevBodyOverflow;
      document.documentElement.style.overflow = prevHtmlOverflow;
      document.body.style.touchAction = prevBodyTouch;
    };
  }, [open]);

  if (!open) return null;
  if (typeof document === 'undefined') return null;

  const threshold = Math.max(0, maxX - 1);
  const progressRatio = Math.min(1, Math.max(0, dragX / Math.max(1, maxX)));
  const nearingSend =
    !loading && !slideCompleted && maxX > 0 && progressRatio >= 0.9;
  const progressHue = Math.round(progressRatio * 120); // 0=red, 120=green
  const pendingTrackBg = `hsl(${progressHue} 80% 95%)`;
  const pendingTrackBorder = `hsl(${progressHue} 65% 80%)`;
  const pendingFill = `hsla(${progressHue}, 80%, 42%, 0.24)`;
  const pendingText = `hsl(${progressHue} 72% 35%)`;
  const pendingHandle = `hsl(${progressHue} 82% 44%)`;
  const pendingHandleShadow = `0 8px 24px hsla(${progressHue}, 82%, 44%, 0.35)`;

  const confirm = () => {
    if (!canConfirm || loading || slideCompleted || confirmedRef.current)
      return;
    confirmedRef.current = true;
    setDragX(maxX);
    setSlideCompleted(true);
    onConfirm();
  };

  const handleStop = (_: unknown, data: { x: number }) => {
    if (slideCompleted || loading || maxX <= 0) return;

    const finalX = Math.min(Math.max(0, data.x), maxX);
    if (finalX >= threshold) {
      if (!canConfirm) {
        setDragX(0);
        setSlideCompleted(false);
        return;
      }
      confirm();
    } else {
      setDragX(0);
      setSlideCompleted(false);
    }
  };

  const progress = Math.min(100, (dragX / Math.max(1, maxX)) * 100);

  return createPortal(
    <div className="fixed inset-0 z-[3000]">
      <div
        className="absolute inset-0 bg-black/28 backdrop-blur-[6px]"
        onClick={loading ? undefined : onCancel}
      />

      <div className="relative mx-auto flex h-full w-full max-w-[430px] items-center px-3 py-4 sm:px-4 sm:py-8">
        <div
          ref={dialogRef}
          className="wallet-popup-panel flex w-full flex-col overflow-hidden rounded-[28px] shadow-[0_24px_70px_rgba(0,0,0,0.3)]"
          role="dialog"
          aria-modal="true"
          aria-label={title}
          tabIndex={-1}
          style={{
            maxHeight:
              'min(84vh, calc(100dvh - var(--safe-top) - var(--safe-bottom) - 24px))',
          }}
        >
          <div className="px-5 pt-3 pb-3 wallet-surface">
            <div className="mx-auto h-1.5 w-10 rounded-full wallet-surface-strong" />

            <div className="mt-3 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[28px] leading-8 font-semibold tracking-[-0.02em] wallet-text-strong">
                  {title}
                </div>
                {subtitle ? (
                  <div className="text-[15px] leading-5 wallet-muted mt-1.5">
                    {subtitle}
                  </div>
                ) : null}
              </div>

              <button
                ref={closeButtonRef}
                type="button"
                onClick={onCancel}
                disabled={loading}
                className="shrink-0 inline-flex items-center justify-center rounded-full h-11 w-11 wallet-surface-strong wallet-text-strong disabled:opacity-50"
                aria-label={cancelLabel}
                title={cancelLabel}
              >
                ✕
              </button>
            </div>

            {warning ? (
              <div className="mt-3 rounded-2xl wallet-surface-strong border border-[var(--wallet-border)] px-3.5 py-2.5 text-[13px] leading-5 wallet-text-strong">
                {warning}
              </div>
            ) : (
              <div className="mt-3 rounded-2xl wallet-surface-strong border border-[var(--wallet-border)] px-3.5 py-2.5 text-[13px] leading-5 wallet-text-strong">
                {defaultWarning}
              </div>
            )}
          </div>

          {children ? (
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-2">
              {children}
            </div>
          ) : null}

          <div className="px-4 pb-4 pt-2 wallet-surface">
            {confirmationMode === 'button' ? (
              <button
                type="button"
                className="wallet-btn-primary min-h-[48px] w-full"
                disabled={!canConfirm || loading || slideCompleted}
                onClick={confirm}
              >
                {loading ? 'Working…' : confirmationLabel}
              </button>
            ) : (
              <>
                <div className="text-[15px] wallet-muted mb-2.5 px-1">
                  {loading
                    ? 'Working…'
                    : slideCompleted
                      ? 'Confirmed'
                      : nearingSend
                        ? 'Release to send'
                        : 'Slide to confirm'}
                </div>
                <div
                  ref={trackRef}
                  className={`relative w-full h-14 rounded-[18px] border overflow-hidden transition-colors ${
                    slideCompleted ? 'bg-emerald-50 border-emerald-200' : ''
                  }`}
                  style={
                    slideCompleted
                      ? undefined
                      : {
                          backgroundColor: pendingTrackBg,
                          borderColor: pendingTrackBorder,
                        }
                  }
                >
                  <div className="absolute right-0 top-0 h-14 w-[18%] bg-amber-100/70 border-l border-amber-200/80 pointer-events-none" />

                  <div
                    className="absolute left-0 top-0 h-14 pointer-events-none"
                    style={{
                      width: `${progress}%`,
                      backgroundColor: slideCompleted
                        ? 'rgba(16,185,129,0.2)'
                        : pendingFill,
                    }}
                  />

                  <div className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none">
                    <span
                      className="text-[10px] font-bold tracking-wide"
                      style={{
                        color: slideCompleted ? 'rgb(4 120 87)' : pendingText,
                      }}
                    >
                      CONFIRM
                    </span>
                  </div>

                  <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <span
                      className="text-[15px] leading-none tracking-[0.02em] font-semibold transition-colors"
                      style={{
                        color: slideCompleted ? 'rgb(4 120 87)' : pendingText,
                      }}
                    >
                      {loading
                        ? 'Working…'
                        : slideCompleted
                          ? 'Confirmed'
                          : nearingSend
                            ? 'Release to send'
                            : 'Slide to confirm'}
                    </span>
                  </div>

                  <Draggable
                    axis="x"
                    bounds={{ left: 0, right: maxX }}
                    position={{ x: dragX, y: 0 }}
                    onDrag={(_, data) =>
                      setDragX(Math.min(Math.max(0, data.x), maxX))
                    }
                    onStop={handleStop}
                    disabled={loading || slideCompleted || maxX <= 0}
                  >
                    <div
                      className={`absolute left-0 top-0 h-14 w-14 rounded-[18px] flex items-center justify-center text-white text-xl select-none transition-colors ${
                        slideCompleted
                          ? 'bg-emerald-600 shadow-[0_8px_24px_rgba(5,150,105,0.35)]'
                          : ''
                      }`}
                      style={
                        slideCompleted
                          ? undefined
                          : {
                              backgroundColor: pendingHandle,
                              boxShadow: pendingHandleShadow,
                            }
                      }
                    >
                      {slideCompleted ? '✓' : '→'}
                    </div>
                  </Draggable>
                </div>
                <button
                  type="button"
                  className="sr-only focus:not-sr-only focus:mt-3 focus:block focus:w-full wallet-btn-primary"
                  disabled={!canConfirm || loading || slideCompleted}
                  onClick={confirm}
                >
                  Confirm action
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};
