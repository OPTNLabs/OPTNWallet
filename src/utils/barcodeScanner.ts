import {
  CapacitorBarcodeScanner,
  CapacitorBarcodeScannerAndroidScanningLibrary,
  CapacitorBarcodeScannerOptions,
  CapacitorBarcodeScannerScanResult,
} from '@capacitor/barcode-scanner';
import { isWebPlatform } from './platform';

let videoInputCheck: Promise<boolean> | null = null;

export class NoCameraAvailableError extends Error {
  constructor(message = 'No camera is available on this device') {
    super(message);
    this.name = 'NoCameraAvailableError';
  }
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error ?? '');
}

export function isIgnorableBarcodeScannerError(error: unknown): boolean {
  const message = toErrorMessage(error);
  return (
    message.includes('Cannot stop, scanner is not running or paused') ||
    message.includes('scanner is not running or paused') ||
    message.includes('user cancelled') ||
    message.includes('user canceled')
  );
}

export function isNoCameraAvailableError(
  error: unknown
): error is NoCameraAvailableError {
  if (error instanceof NoCameraAvailableError) return true;
  const message = toErrorMessage(error);
  return (
    message.includes('Error getting userMedia') ||
    message.includes('NotFoundError') ||
    message.includes('Requested device not found') ||
    message.includes('No camera is available')
  );
}

export function getBarcodeScannerErrorMessage(error: unknown): string {
  if (isNoCameraAvailableError(error)) {
    return 'No camera is available in this browser. Use manual entry here or test scanning on a mobile device.';
  }
  return 'Failed to scan QR code. Please ensure camera permissions are granted and try again.';
}

/**
 * Android scans through ZXing rather than the plugin's ML Kit default.
 *
 * ML Kit is proprietary. It also drags Google Play Services into the build:
 * play-services-mlkit-barcode-scanning, a ~5 MB libbarhopper native library
 * per ABI, and bundled TensorFlow Lite models. That makes an F-Droid build
 * ineligible under their inclusion policy, which requires every dependency to
 * be free software — not merely the application.
 *
 * ZXing is the reference QR implementation and what the wallets this one sits
 * beside use — Electrum, Sparrow, Monero. The plugin's own documentation notes
 * ZXing covers every format it supports and several ML Kit does not. This
 * wallet scans QR codes, so nothing is given up.
 *
 * Set here, at the single point every scan passes through, rather than per
 * flavour: one Android code path is tested by everyone rather than leaving
 * F-Droid users on a path Play users never exercise.
 */
export const ANDROID_SCANNING_LIBRARY =
  CapacitorBarcodeScannerAndroidScanningLibrary.ZXING;

export async function scanBarcodeSafely(
  options: CapacitorBarcodeScannerOptions
): Promise<CapacitorBarcodeScannerScanResult | null> {
  try {
    await ensureCameraAvailableForWeb();
    return await CapacitorBarcodeScanner.scanBarcode({
      ...options,
      android: {
        ...options.android,
        scanningLibrary: ANDROID_SCANNING_LIBRARY,
      },
    });
  } catch (error) {
    if (isIgnorableBarcodeScannerError(error)) {
      return null;
    }
    if (isNoCameraAvailableError(error)) {
      throw new NoCameraAvailableError();
    }
    throw error;
  }
}

export function installBarcodeScannerUnhandledRejectionGuard() {
  if (typeof window === 'undefined') return;

  window.addEventListener('unhandledrejection', (event) => {
    if (!isIgnorableBarcodeScannerError(event.reason)) return;
    event.preventDefault();
  });
}

async function ensureCameraAvailableForWeb(): Promise<void> {
  if (!isWebPlatform()) return;
  if (typeof navigator === 'undefined' || !navigator.mediaDevices) {
    throw new NoCameraAvailableError();
  }

  const hasVideoInput = await hasAvailableVideoInput();
  if (!hasVideoInput) {
    throw new NoCameraAvailableError();
  }
}

async function hasAvailableVideoInput(): Promise<boolean> {
  if (!videoInputCheck) {
    videoInputCheck = navigator.mediaDevices
      .enumerateDevices()
      .then((devices) => devices.some((device) => device.kind === 'videoinput'))
      .catch(() => true);
  }
  return videoInputCheck;
}
