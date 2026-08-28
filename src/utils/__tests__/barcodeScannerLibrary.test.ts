import { beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock is hoisted above the file, so the spy is created inside the factory
// and read back afterwards rather than captured from an outer binding.
vi.mock('@capacitor/barcode-scanner', () => ({
  CapacitorBarcodeScanner: { scanBarcode: vi.fn() },
  CapacitorBarcodeScannerAndroidScanningLibrary: {
    ZXING: 'zxing',
    MLKIT: 'mlkit',
  },
  CapacitorBarcodeScannerTypeHint: { ALL: 0 },
}));

vi.mock('../platform', () => ({ isWebPlatform: () => false }));

import { CapacitorBarcodeScanner } from '@capacitor/barcode-scanner';
import { scanBarcodeSafely } from '../barcodeScanner';

const scanBarcode = vi.mocked(CapacitorBarcodeScanner.scanBarcode);

describe('Android barcode scanning library', () => {
  beforeEach(() => {
    scanBarcode.mockReset();
    scanBarcode.mockResolvedValue({ ScanResult: 'bitcoincash:qtest' });
  });

  it('scans through ZXing rather than the plugin default', async () => {
    // The plugin defaults to ML Kit, which is proprietary and pulls Google
    // Play Services into the APK. That makes an F-Droid build ineligible, so
    // the choice is asserted rather than left to the plugin's default.
    await scanBarcodeSafely({ hint: 0 } as never);

    expect(scanBarcode).toHaveBeenCalledTimes(1);
    expect(scanBarcode.mock.calls[0][0].android.scanningLibrary).toBe('zxing');
  });

  it('keeps the caller options and cannot be overridden into ML Kit', async () => {
    // A call site passing its own android block must not be able to reinstate
    // the dependency the build no longer contains — that would throw
    // NoClassDefFoundError on a device rather than fail here.
    await scanBarcodeSafely({
      hint: 0,
      scanText: 'Scan an address',
      android: { scanningLibrary: 'mlkit' },
    } as never);

    const passed = scanBarcode.mock.calls[0][0];
    expect(passed.scanText).toBe('Scan an address');
    expect(passed.android.scanningLibrary).toBe('zxing');
  });
});
