import { useState } from 'react';
import { CapacitorBarcodeScannerTypeHint } from '@capacitor/barcode-scanner';
import { Toast } from '@capacitor/toast';
import { Network } from '../../state/slices/networkSlice';
import { AssetType } from '../../hooks/simple-send/types';
import { parseBip21Uri } from '../../utils/bip21';
import {
  getBarcodeScannerErrorMessage,
  scanBarcodeSafely,
} from '../../utils/barcodeScanner';
import { useI18n } from '../../i18n/useI18n';

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
  const { t } = useI18n();
  const [scanBusy, setScanBusy] = useState(false);

  const handleScanRecipient = async () => {
    try {
      setScanBusy(true);
      const result = await scanBarcodeSafely({
        hint: CapacitorBarcodeScannerTypeHint.ALL,
        cameraDirection: 1,
      });

      const scanned = result?.ScanResult?.trim();
      if (!scanned) {
        await Toast.show({ text: t('home.noQrCode') });
        return;
      }

      const parsed = parseBip21Uri(scanned, currentNetwork);
      if (parsed.isValidAddress) {
        setRecipient(parsed.normalizedAddress);
        if (parsed.amountRaw) {
          setAssetType('bch');
          setAmountBch(parsed.amountRaw);
          await Toast.show({ text: t('send.recipientAmountLoaded') });
          return;
        }
        await Toast.show({ text: t('send.recipientLoaded') });
        return;
      }

      setRecipient(scanned);
      await Toast.show({ text: t('send.verifyRecipient') });
    } catch (e) {
      console.error('QR scan failed:', e);
      await Toast.show({
        text: getBarcodeScannerErrorMessage(e),
      });
    } finally {
      setScanBusy(false);
    }
  };

  return { scanBusy, handleScanRecipient };
}
