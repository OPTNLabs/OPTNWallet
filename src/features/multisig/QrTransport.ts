import { CapacitorBarcodeScannerTypeHint } from '@capacitor/barcode-scanner';
import { scanBarcodeSafely } from '../../utils/barcodeScanner';

/** Platform-neutral QR exchange boundary used by multisig screens. */
export interface QrTransport {
  scanSingle(): Promise<string | null>;
  scanAnimated(onFrame: (frame: string) => void): Promise<void>;
  displayAnimated(frames: string[]): Promise<void>;
}

export type QrTransportOptions = {
  displayAnimated?: (frames: string[]) => Promise<void>;
};

/**
 * The scanner is supplied by Capacitor on Android/iOS and by the existing
 * desktop barcode shim in the desktop build. The shared feature never imports
 * either platform implementation.
 */
export function createQrTransport(
  options: QrTransportOptions = {}
): QrTransport {
  const scanSingle = async (): Promise<string | null> => {
    const result = await scanBarcodeSafely({
      hint: CapacitorBarcodeScannerTypeHint.QR_CODE,
      scanInstructions: 'Scan the multisig xpub or PSBT QR code',
      scanButton: true,
    });
    return result?.ScanResult?.trim() || null;
  };

  return {
    scanSingle,
    async scanAnimated(onFrame) {
      // Native scanners return one decoded frame per invocation. Reopening the
      // scanner is intentional: it works on both Capacitor and the desktop
      // file fallback and lets UR decoders handle duplicates/out-of-order data.
      for (;;) {
        const frame = await scanSingle();
        if (!frame) return;
        onFrame(frame);
      }
    },
    async displayAnimated(frames) {
      if (options.displayAnimated) {
        await options.displayAnimated(frames);
        return;
      }
      throw new Error('This screen has no animated QR display adapter.');
    },
  };
}
