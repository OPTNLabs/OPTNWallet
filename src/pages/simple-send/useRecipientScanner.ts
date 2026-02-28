import { useState } from 'react';
import {
  CapacitorBarcodeScanner,
  CapacitorBarcodeScannerTypeHint,
} from '@capacitor/barcode-scanner';
import { Toast } from '@capacitor/toast';

type UseRecipientScannerParams = {
  setRecipient: (value: string) => void;
};

export function useRecipientScanner({ setRecipient }: UseRecipientScannerParams) {
  const [scanBusy, setScanBusy] = useState(false);

  const handleScanRecipient = async () => {
    try {
      setScanBusy(true);
      const result = await CapacitorBarcodeScanner.scanBarcode({
        hint: CapacitorBarcodeScannerTypeHint.ALL,
        cameraDirection: 1,
      });

      const scanned = result?.ScanResult?.trim();
      if (!scanned) {
        await Toast.show({ text: 'No QR detected. Try again.' });
        return;
      }

      const maybeAddr = scanned.startsWith('bitcoincash:') ? scanned : scanned;
      setRecipient(maybeAddr);
      await Toast.show({ text: 'Recipient loaded from QR.' });
    } catch (e) {
      console.error('QR scan failed:', e);
      await Toast.show({
        text: 'Failed to scan QR. Check camera permissions and try again.',
      });
    } finally {
      setScanBusy(false);
    }
  };

  return { scanBusy, handleScanRecipient };
}
