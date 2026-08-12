import {
  CapacitorBarcodeScanner,
  CapacitorBarcodeScannerOptions,
  CapacitorBarcodeScannerScanResult,
} from '@capacitor/barcode-scanner';
import { Capacitor } from '@capacitor/core';

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

export async function scanBarcodeSafely(
  options: CapacitorBarcodeScannerOptions
): Promise<CapacitorBarcodeScannerScanResult | null> {
  try {
    await ensureCameraAvailableForWeb();
    return await CapacitorBarcodeScanner.scanBarcode(options);
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
  if (Capacitor.getPlatform() !== 'web') return;
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
