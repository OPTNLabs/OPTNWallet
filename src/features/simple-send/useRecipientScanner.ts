import { useState } from 'react';
import { CapacitorBarcodeScannerTypeHint } from '@capacitor/barcode-scanner';
import { Network } from '../../state/slices/networkSlice';
import { AssetType } from '../../hooks/simple-send/types';
import { parseBip21Uri } from '../../utils/bip21';
import {
  getBarcodeScannerErrorMessage,
  scanBarcodeSafely,
} from '../../utils/barcodeScanner';
import { useI18n } from '../../i18n/useI18n';
import { showWalletNotification } from '../../utils/copyWithFeedback';

type UseRecipientScannerParams = {
  setRecipient: (value: string) => void;
  setAmountBch: (value: string) => void;
  setAssetType: (value: AssetType) => void;
  currentNetwork: Network;
  assetType: AssetType;
};

export function useRecipientScanner({
  setRecipient,
  setAmountBch,
  setAssetType,
  currentNetwork,
  assetType,
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
        await showWalletNotification(t('home.noQrCode'));
        return;
      }

      const parsed = parseBip21Uri(scanned, currentNetwork);
      if (parsed.invalidAmount) {
        await showWalletNotification(t('send.invalidBip21Amount'));
        return;
      }
      if (parsed.isValidAddress) {
        setRecipient(parsed.normalizedAddress);
        if (parsed.amountRaw && assetType === 'bch') {
          setAssetType('bch');
          setAmountBch(parsed.amountRaw);
          await showWalletNotification(t('send.recipientAmountLoaded'));
          return;
        }
        await showWalletNotification(t('send.recipientLoaded'));
        return;
      }

      setRecipient(scanned);
      await showWalletNotification(t('send.verifyRecipient'));
    } catch (e) {
      console.error('QR scan failed:', e);
      await showWalletNotification(getBarcodeScannerErrorMessage(e));
    } finally {
      setScanBusy(false);
    }
  };

  return { scanBusy, handleScanRecipient };
}
