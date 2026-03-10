import { useState } from 'react';
import {
  CapacitorBarcodeScanner,
  CapacitorBarcodeScannerTypeHint,
} from '@capacitor/barcode-scanner';
import { Toast } from '@capacitor/toast';
import { Network } from '../../redux/networkSlice';
import { AssetType } from '../../hooks/simple-send/types';
import { parseBip21Uri } from '../../utils/bip21';

type UseRecipientScannerParams = {
  setRecipient: (value: string) => void;
  setAmountBch: (value: string) => void;
  setAssetType: (value: AssetType) => void;
  currentNetwork: Network;
};

export function useRecipientScanner({
  setRecipient,
  setAmountBch,
  setAssetType,
  currentNetwork,
}: UseRecipientScannerParams) {
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

      const parsed = parseBip21Uri(scanned, currentNetwork);
      if (parsed.isValidAddress) {
        setRecipient(parsed.normalizedAddress);
        if (parsed.amountRaw) {
          setAssetType('bch');
          setAmountBch(parsed.amountRaw);
          await Toast.show({ text: 'Recipient and amount loaded from QR.' });
          return;
        }
        await Toast.show({ text: 'Recipient loaded from QR.' });
        return;
      }

      setRecipient(scanned);
      await Toast.show({ text: 'QR scanned. Verify recipient before sending.' });
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
