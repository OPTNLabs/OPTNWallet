// Live-camera QR scanner shared by desktop and mobile WebViews. Opens the webcam, decodes QR frames with
// jsQR, and hands each decoded string to the caller — used for air-gapped
// import (point the camera at a QR shown on another device). If the camera is
// unavailable it surfaces an error and the caller's "Upload" path remains.
//
// Two things here are load-bearing and were both wrong before.
//
// The camera is opened once per mount. The effect used to depend on `onResult`,
// which callers declare inline, so it tore down and re-ran on every parent
// render. Worse, `stream` was only assigned after `getUserMedia` resolved, so a
// cleanup that ran while that promise was still pending stopped nothing and
// orphaned the stream — leaving the device open. The next attempt then found
// the camera busy and failed with "The operation was aborted", which is exactly
// what testers reported. Callbacks now live in refs and the stream is stopped
// even when the await loses its race.
//
// Decoding is throttled and downscaled. Running jsQR over a full-resolution
// frame on every animation frame is most of a core, which is why scanning felt
// slow; the camera itself was never the bottleneck.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import { useI18n } from '../../i18n/useI18n';

interface Props {
  onResult: (text: string) => void;
  onClose: () => void;
  /**
   * Keep scanning after the first decode, reporting every new frame.
   *
   * Animated URs arrive as dozens of frames, so a scanner that stops at the
   * first one can never finish a multi-part payload. Single-QR callers leave
   * this off and close themselves on the first result.
   */
  continuous?: boolean;
  /** 0..1, drawn as a bar. Multi-frame callers pass their decoder's progress. */
  progress?: number | null;
  /** Replaces the default hint, e.g. "12 of 40 parts". */
  statusText?: string;
}

/** Longest edge used for decoding. Plenty for a QR filling the frame. */
const SCAN_EDGE = 640;
/** ~12fps. jsQR is the expensive part; the camera runs at its own rate. */
const SCAN_INTERVAL_MS = 80;
/** How long the detection light stays lit after a frame lands. */
const DETECT_FLASH_MS = 300;

export const CameraQrScanner: React.FC<Props> = ({
  onResult,
  onClose,
  continuous = false,
  progress = null,
  statusText,
}) => {
  const { t } = useI18n();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [frameCount, setFrameCount] = useState(0);

  // Held in refs so the camera effect does not depend on their identity. A
  // caller that declares these inline would otherwise reopen the device on
  // every render.
  const onResultRef = useRef(onResult);
  const continuousRef = useRef(continuous);
  useEffect(() => {
    onResultRef.current = onResult;
    continuousRef.current = continuous;
  }, [onResult, continuous]);

  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const markDetected = useCallback(() => {
    setDetecting(true);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setDetecting(false), DETECT_FLASH_MS);
  }, []);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    let lastText: string | null = null;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const stopStream = () => {
      stream?.getTracks().forEach((track) => track.stop());
      stream = null;
    };

    const tick = () => {
      const video = videoRef.current;
      if (cancelled) return;
      if (video && ctx && video.readyState >= 2 && video.videoWidth > 0) {
        // Downscaled: a 1080p frame is ~2M pixels through jsQR, and a QR that
        // fills the frame survives the reduction comfortably.
        const scale = Math.min(1, SCAN_EDGE / video.videoWidth);
        canvas.width = Math.round(video.videoWidth * scale);
        canvas.height = Math.round(video.videoHeight * scale);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
        // Screens show QRs the right way round, and attempting the inverse
        // doubles the work for a case that does not arise here.
        const code = jsQR(image.data, image.width, image.height, {
          inversionAttempts: 'dontInvert',
        });
        const text = code?.data?.trim();
        if (text) {
          // The same frame stays in view for many ticks while an animated UR
          // advances. Reporting it once per appearance keeps the caller's
          // decoder from counting one part dozens of times.
          if (text !== lastText) {
            lastText = text;
            markDetected();
            setFrameCount((count) => count + 1);
            onResultRef.current(text);
            if (!continuousRef.current) return;
          }
        }
      }
      if (!cancelled) timer = setTimeout(tick, SCAN_INTERVAL_MS);
    };

    void (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error(t('qr.cameraUnavailable'));
        }
        // `ideal`, not a bare value: a laptop has only a user-facing camera,
        // and an unsatisfiable exact constraint fails outright.
        const opened = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        });
        // The await above can lose a race with cleanup. Stopping the stream we
        // just opened is what keeps the device from staying held.
        if (cancelled || !videoRef.current) {
          opened.getTracks().forEach((track) => track.stop());
          return;
        }
        stream = opened;
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        if (cancelled) {
          stopStream();
          return;
        }
        timer = setTimeout(tick, SCAN_INTERVAL_MS);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : t('qr.cameraError'));
      }
    })();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      stopStream();
    };
    // `t` only: the callbacks are read through refs on purpose, so that a
    // caller re-rendering does not reopen the camera.
  }, [t, markDetected]);

  useEffect(
    () => () => {
      if (flashTimer.current) clearTimeout(flashTimer.current);
    },
    []
  );

  const percent =
    progress === null || progress === undefined
      ? null
      : Math.max(0, Math.min(100, Math.round(progress * 100)));

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/80 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg space-y-3 rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] p-4"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-semibold wallet-text-strong">
            {t('camera.scan')}
          </p>
          {/* Detection light. Paired with text rather than standing alone:
              colour is not a signal a screen reader can relay. */}
          <span className="flex items-center gap-1.5 text-[11px] wallet-muted">
            <span
              aria-hidden="true"
              className={`inline-block h-2.5 w-2.5 rounded-full transition-colors ${
                detecting
                  ? 'bg-[var(--wallet-accent)]'
                  : 'bg-[var(--wallet-border)]'
              }`}
            />
            {frameCount > 0 ? `${frameCount}` : t('qr.cameraActive')}
          </span>
        </div>

        {error ? (
          <p className="text-xs text-red-400" role="alert">
            {t('camera.unavailable', { error })}
          </p>
        ) : (
          <>
            <video
              ref={videoRef}
              playsInline
              muted
              className={`aspect-square w-full rounded-lg bg-black object-cover ring-2 transition-colors ${
                detecting ? 'ring-[var(--wallet-accent)]' : 'ring-transparent'
              }`}
            />
            <div className="space-y-1.5" aria-live="polite">
              {percent === null ? null : (
                <div
                  className="h-2 overflow-hidden rounded-full bg-black/30"
                  role="progressbar"
                  aria-valuenow={percent}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <div
                    className="h-full rounded-full bg-[var(--wallet-accent)] transition-[width]"
                    style={{ width: `${percent}%` }}
                  />
                </div>
              )}
              <p className="text-xs wallet-muted">
                {statusText ?? t('qr.holdSteady')}
              </p>
            </div>
          </>
        )}

        <button
          type="button"
          onClick={onClose}
          className="w-full rounded-md border border-[var(--wallet-border)] py-2 text-sm font-semibold wallet-text-strong"
        >
          {t('camera.cancel')}
        </button>
      </div>
    </div>
  );
};
