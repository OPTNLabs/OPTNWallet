import { useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import {
  encodeMultisigCosignerUr,
  type MultisigCosignerQrPayload,
} from '../../services/multisig/MultisigQrService';

export default function MultisigCosignerQr(props: {
  payload: MultisigCosignerQrPayload;
  onClose: () => void;
}) {
  const [frames] = useState(() =>
    encodeMultisigCosignerUr(props.payload, 1000)
  );
  const [frameIndex, setFrameIndex] = useState(0);

  useEffect(() => {
    if (frames.length <= 1) return;
    const timer = window.setInterval(() => {
      setFrameIndex((current) => (current + 1) % frames.length);
    }, 450);
    return () => window.clearInterval(timer);
  }, [frames.length]);

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/80 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="multisig-cosigner-qr-title"
    >
      <div className="w-full max-w-sm space-y-4 rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] p-5">
        <div>
          <h2
            id="multisig-cosigner-qr-title"
            className="font-semibold wallet-text-strong"
          >
            Scan this cosigner QR
          </h2>
          <p className="mt-1 text-xs wallet-muted">
            This single exchange includes the account xpub, master fingerprint,
            and derivation path. Scan it from the multisig setup on the other
            device.
          </p>
        </div>
        <div className="flex justify-center rounded-xl bg-white p-4">
          <QRCodeSVG value={frames[frameIndex]} size={260} includeMargin />
        </div>
        <div className="space-y-1 text-center text-xs wallet-muted">
          <p>Fingerprint: {props.payload.masterFingerprintHex.toUpperCase()}</p>
          <p>Path: {props.payload.accountPath}</p>
          {frames.length > 1 && (
            <p>
              Animated frame {frameIndex + 1} of {frames.length}
            </p>
          )}
        </div>
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
