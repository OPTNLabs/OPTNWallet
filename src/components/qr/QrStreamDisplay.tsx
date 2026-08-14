import React, { useEffect, useMemo, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { QrStreamEncoder } from '../../services/qrStream';
import { useI18n } from '../../i18n/useI18n';

type Props = {
  payload: Uint8Array;
  blockLength?: number;
  sessionId?: number;
  framesPerSecond?: number;
  className?: string;
};

/** Displays an endless fountain-coded QR stream. */
export const QrStreamDisplay: React.FC<Props> = ({
  payload,
  blockLength,
  sessionId,
  framesPerSecond = 20,
  className,
}) => {
  const { t } = useI18n();
  const [sequence, setSequence] = useState(0);
  const encoder = useMemo(
    () => new QrStreamEncoder(payload, blockLength, sessionId),
    [payload, blockLength, sessionId]
  );

  useEffect(() => {
    const intervalMs = 1000 / Math.max(1, framesPerSecond);
    const timer = window.setInterval(() => {
      setSequence((current) => (current + 1) >>> 0);
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [framesPerSecond]);

  return (
    <div className="space-y-2">
      <QRCodeSVG
        value={encoder.qrPayload(sequence)}
        size={320}
        level="L"
        includeMargin
        className={`h-auto w-full ${className ?? ''}`.trim()}
        aria-label={t('qr.animatedTransfer')}
      />
      <p className="text-center text-xs text-black/60">
        {t('qr.streaming', {
          frame: sequence + 1,
          blocks: encoder.blockCount,
          bytes: encoder.totalLength,
        })}
      </p>
    </div>
  );
};
