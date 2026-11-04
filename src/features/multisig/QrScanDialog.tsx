import { useState } from 'react';
import { createQrTransport } from './QrTransport';
import Popup from '../transaction/components/Popup';
import MultisigError from './MultisigError';

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
    <Popup
      closePopups={props.onClose}
      closeButtonText="Done"
      ariaLabel="Scan QR frame"
    >
      <div className="space-y-3 p-1">
        <h2 className="font-semibold wallet-text-strong">Scan QR frame</h2>
        <p className="text-xs wallet-muted">
          Use the camera on mobile or the desktop image/file fallback. Scan each
          UR frame; duplicates are safe.
        </p>
        {error && <MultisigError message={error} />}
        <button
          type="button"
          className="wallet-btn-primary min-h-[44px] w-full"
          onClick={() => void scan()}
          disabled={busy}
        >
          {busy ? 'Scanning…' : 'Scan frame'}
        </button>
      </div>
    </Popup>
  );
}
