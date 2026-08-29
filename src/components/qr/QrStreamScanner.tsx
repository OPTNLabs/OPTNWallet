import React, { useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import {
  QrStreamDecoder,
  type QrStreamProgress,
} from '../../services/qrStream';
import { useI18n } from '../../i18n/useI18n';

type Props = {
  onComplete: (payload: Uint8Array) => void;
  onProgress?: (progress: QrStreamProgress | null) => void;
  onClose?: () => void;
  initialPayload?: string;
  className?: string;
};

/** Continuously scans camera frames until a fountain stream is complete. */
export const QrStreamScanner: React.FC<Props> = ({
  onComplete,
  onProgress,
  onClose,
  initialPayload,
  className,
}) => {
  const { t } = useI18n();
  const videoRef = useRef<HTMLVideoElement>(null);
  const decoderRef = useRef(new QrStreamDecoder());
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<QrStreamProgress | null>(null);

  const progressPercent = progress
    ? progress.complete
      ? 100
      : Math.min(
          99,
          Math.round(
            (progress.framesReceived /
              Math.max(
                progress.blockCount + 8,
                Math.ceil(progress.blockCount * 1.2)
              )) *
              100
          )
        )
    : 0;

  useEffect(() => {
    let stream: MediaStream | null = null;
    let animationFrame = 0;
    let cancelled = false;
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });

    if (initialPayload) {
      try {
        const recovered = decoderRef.current.addQrPayload(initialPayload);
        const nextProgress = decoderRef.current.progress;
        setProgress(nextProgress);
        onProgress?.(nextProgress);
        if (recovered) {
          onComplete(recovered);
          return () => {
            cancelled = true;
          };
        }
      } catch (initialScanError) {
        setError(
          initialScanError instanceof Error
            ? initialScanError.message
            : t('qr.unableToDecode')
        );
      }
    }

    const scan = () => {
      const video = videoRef.current;
      if (
        !cancelled &&
        video &&
        context &&
        video.readyState >= 2 &&
        video.videoWidth > 0
      ) {
        const scanWidth = Math.min(video.videoWidth, 1280);
        canvas.width = scanWidth;
        canvas.height = Math.round(
          video.videoHeight * (scanWidth / video.videoWidth)
        );
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const image = context.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(image.data, image.width, image.height, {
          inversionAttempts: 'attemptBoth',
        });
        if (code?.data) {
          try {
            const recovered = decoderRef.current.addQrPayload(code.data);
            const nextProgress = decoderRef.current.progress;
            setProgress(nextProgress);
            onProgress?.(nextProgress);
            if (recovered) {
              onComplete(recovered);
              return;
            }
          } catch (scanError) {
            setError(
              scanError instanceof Error
                ? scanError.message
                : t('qr.unableToDecode')
            );
            return;
          }
        }
      }
      if (!cancelled) animationFrame = requestAnimationFrame(scan);
    };

    void (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia)
          throw new Error(t('qr.cameraUnavailable'));
        const opened = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        });
        // Stopped explicitly rather than left to the cleanup below: a cleanup
        // that runs while this await is pending sees no stream yet and stops
        // nothing, orphaning the device. The next open then finds the camera
        // busy and fails with "The operation was aborted".
        if (cancelled || !videoRef.current) {
          opened.getTracks().forEach((track) => track.stop());
          return;
        }
        stream = opened;
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          stream = null;
          return;
        }
        animationFrame = requestAnimationFrame(scan);
      } catch (cameraError) {
        setError(
          cameraError instanceof Error
            ? cameraError.message
            : t('qr.cameraError')
        );
      }
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(animationFrame);
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [initialPayload, onComplete, onProgress, t]);

  return (
    <div className={className}>
      {error ? (
        <p role="alert">{error}</p>
      ) : (
        <>
          <video
            ref={videoRef}
            playsInline
            muted
            className="w-full rounded-lg bg-black"
          />
          <div className="mt-3 space-y-2" aria-live="polite">
            <div className="flex justify-between text-xs wallet-text-muted">
              <span>
                {progress ? t('qr.receivingStream') : t('qr.cameraActive')}
              </span>
              <span>{progressPercent}%</span>
            </div>
            <div
              className="h-2 overflow-hidden rounded-full bg-black/30"
              role="progressbar"
              aria-valuenow={progressPercent}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div
                className="h-full rounded-full bg-[var(--wallet-accent)] transition-[width]"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
            {progress ? (
              <p className="text-xs wallet-text-muted">
                {progress.framesReceived} {t('qr.uniqueFrames')} ·{' '}
                {progress.blocksSolved}/{progress.blockCount}{' '}
                {t('qr.blocksRecovered')} · {progress.duplicateFrames}{' '}
                {t('qr.duplicates')}
              </p>
            ) : (
              <p className="text-xs wallet-text-muted">{t('qr.holdSteady')}</p>
            )}
          </div>
        </>
      )}
      {onClose ? (
        <button type="button" onClick={onClose}>
          {t('qr.cancel')}
        </button>
      ) : null}
    </div>
  );
};
