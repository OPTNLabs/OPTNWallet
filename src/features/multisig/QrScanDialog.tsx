import { useState } from 'react';
import { createQrTransport } from './QrTransport';

export function QrScanDialog(props: {
  onFrame: (frame: string) => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const scan = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const frame = await createQrTransport().scanSingle();
      if (frame) props.onFrame(frame);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Could not scan the QR code.'
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/80 p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full max-w-sm space-y-3 rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] p-4">
        <h2 className="font-semibold wallet-text-strong">Scan QR frame</h2>
        <p className="text-xs wallet-muted">
          Use the camera on mobile or the desktop image/file fallback. Scan each
          UR frame; duplicates are safe.
        </p>
        {error && (
          <p role="alert" className="text-xs text-red-400">
            {error}
          </p>
        )}
        <button
          type="button"
          className="wallet-btn-primary w-full"
          onClick={() => void scan()}
          disabled={busy}
        >
          {busy ? 'Scanning…' : 'Scan frame'}
        </button>
        <button
          type="button"
          className="wallet-btn-secondary w-full"
          onClick={props.onClose}
        >
          Done
        </button>
      </div>
    </div>
  );
}
