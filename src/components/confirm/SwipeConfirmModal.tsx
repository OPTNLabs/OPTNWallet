import React, { useEffect, useRef, useState } from 'react';
import Draggable from 'react-draggable';

type Props = {
  open: boolean;
  title: string;
  subtitle?: string;
  warning?: React.ReactNode;

  confirmLabel?: string;
  confirmText?: string;
  cancelText?: string;

  loading?: boolean;
  isBusy?: boolean;
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onCancel?: () => void;
  onClose?: () => void;

  children?: React.ReactNode;
};

export default function SwipeConfirmModal({
  open,
  title,
  subtitle,
  warning,
  confirmLabel = 'Drag to confirm',
  confirmText,
  cancelText,
  loading = false,
  isBusy = false,
  confirmDisabled = false,
  onConfirm,
  onCancel,
  onClose,
  children,
}: Props) {
  const busy = loading || isBusy;
  const close = onCancel ?? onClose ?? (() => {});
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragX, setDragX] = useState(0);
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    if (!open) {
      setDragX(0);
      setConfirmed(false);
    }
  }, [open]);

  if (!open) return null;

  const maxX = Math.max(0, (trackRef.current?.offsetWidth ?? 0) - 64);
  const threshold = Math.max(0, maxX - 10);

  const handleStop = () => {
    if (confirmed || busy || confirmDisabled) return;
    if (dragX >= threshold) {
      setConfirmed(true);
      try {
        onConfirm();
      } finally {
        setDragX(0);
        setConfirmed(false);
      }
    } else {
      setDragX(0);
    }
  };

  const progress = Math.min(100, (dragX / Math.max(1, maxX)) * 100);

  return (
    <div className="fixed inset-0 z-[9999] flex items-end sm:items-center justify-center">
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-[2px]"
        onClick={busy ? undefined : close}
      />

      <div className="relative w-full sm:max-w-3xl mx-auto bg-white rounded-t-3xl sm:rounded-3xl shadow-2xl overflow-hidden">
        <div className="px-5 pt-5 pb-3 border-b border-gray-100">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-lg font-semibold text-gray-900">{title}</div>
              {subtitle ? (
                <div className="text-sm text-gray-600 mt-1">{subtitle}</div>
              ) : null}
            </div>

            <button
              onClick={close}
              disabled={busy}
              className="shrink-0 inline-flex items-center justify-center rounded-full h-10 w-10 bg-gray-100 text-gray-700 disabled:opacity-50"
              aria-label={cancelText ?? 'Cancel'}
              title={cancelText ?? 'Cancel'}
            >
              ✕
            </button>
          </div>

          {warning ? (
            <div className="mt-3 rounded-xl bg-amber-50 border border-amber-100 px-3 py-2 text-sm text-amber-900">
              {warning}
            </div>
          ) : (
            <div className="mt-3 rounded-xl bg-amber-50 border border-amber-100 px-3 py-2 text-sm text-amber-900">
              Broadcasts immediately after confirmation.
            </div>
          )}
        </div>

        {children ? (
          <div className="px-5 py-4 max-h-[70vh] overflow-y-auto">{children}</div>
        ) : null}

        <div className="px-5 pb-5 pt-3 border-t border-gray-100 bg-white">
          <div className="text-sm text-gray-600 mb-2">
            {busy ? 'Preparing…' : 'Swipe to confirm and send'}
          </div>

          <div
            ref={trackRef}
            className={`relative w-full h-14 rounded-2xl bg-gray-100 overflow-hidden ${
              confirmDisabled ? 'opacity-60' : ''
            }`}
          >
            <div
              className="absolute left-0 top-0 h-14 bg-blue-600/10 pointer-events-none"
              style={{ width: `${progress}%` }}
            />

            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <span className="text-base font-semibold text-gray-700">
                {busy ? 'Sending…' : confirmText ?? confirmLabel}
              </span>
            </div>

            <Draggable
              axis="x"
              bounds={{ left: 0, right: maxX }}
              position={{ x: dragX, y: 0 }}
              onDrag={(_, data) => setDragX(data.x)}
              onStop={handleStop}
              disabled={busy || confirmed || confirmDisabled}
            >
              <div className="absolute left-0 top-0 h-14 w-14 rounded-2xl bg-blue-600 shadow-lg flex items-center justify-center text-white text-xl select-none">
                →
              </div>
            </Draggable>
          </div>
        </div>
      </div>
    </div>
  );
}
