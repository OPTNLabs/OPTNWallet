// Live-camera QR scanner (desktop). Opens the webcam, decodes QR frames with
// jsQR, and returns the first decoded string — used for air-gapped import (point
// the camera at a QR shown on another device). If the camera is unavailable, it
// surfaces an error and the caller's "Upload" path remains available.
import React, { useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';

interface Props {
  onResult: (text: string) => void;
  onClose: () => void;
}

export const CameraQrScanner: React.FC<Props> = ({ onResult, onClose }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    let cancelled = false;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const tick = () => {
      const video = videoRef.current;
      if (!cancelled && video && video.readyState >= 2 && ctx && video.videoWidth) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(image.data, image.width, image.height);
        if (code?.data) {
          onResult(code.data.trim());
          return;
        }
      }
      if (!cancelled) raf = requestAnimationFrame(tick);
    };

    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
        });
        if (videoRef.current && !cancelled) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
          raf = requestAnimationFrame(tick);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Camera unavailable');
      }
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [onResult]);

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/80 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm space-y-3 rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] p-4"
        onClick={(event) => event.stopPropagation()}
      >
        <p className="text-sm font-semibold wallet-text-strong">Scan QR with camera</p>
        {error ? (
          <p className="text-xs text-red-400">Camera unavailable: {error}. Use Upload instead.</p>
        ) : (
          <video ref={videoRef} playsInline muted className="aspect-square w-full rounded-lg bg-black object-cover" />
        )}
        <button
          type="button"
          onClick={onClose}
          className="w-full rounded-md border border-[var(--wallet-border)] py-2 text-sm font-semibold wallet-text-strong"
        >
          Cancel
        </button>
      </div>
    </div>
  );
};
