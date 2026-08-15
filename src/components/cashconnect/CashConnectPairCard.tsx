import { useState } from 'react';
import { CapacitorBarcodeScannerTypeHint } from '@capacitor/barcode-scanner';
import { Toast } from '@capacitor/toast';
import { useDispatch, useSelector } from 'react-redux';
import type { AppDispatch, RootState } from '../../state/store';
import {
  initCashConnect,
  pairCashConnectThunk,
} from '../../state/slices/cashconnectSlice';
import {
  getBarcodeScannerErrorMessage,
  scanBarcodeSafely,
} from '../../utils/barcodeScanner';
import { toErrorMessage } from '../../utils/errorHandling';
import { isCashConnectUri } from '../../services/cashconnect/cashconnectInvite';
import ConnectionUriScanCard from '../connect/ConnectionUriScanCard';

export default function CashConnectPairCard() {
  const dispatch = useDispatch<AppDispatch>();
  const walletId = useSelector(
    (state: RootState) => state.wallet_id.currentWalletId
  );
  const [uri, setUri] = useState('');
  const [scanning, setScanning] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const connectToUri = async (value: string) => {
    const nextUri = value.trim();
    if (!isCashConnectUri(nextUri)) {
      await Toast.show({ text: 'Paste a CashConnect URI (bch-cc-v1:…)' });
      return;
    }
    if (submitting) return;
    setSubmitting(true);
    try {
      if (!walletId || walletId <= 0) {
        throw new Error('No active wallet');
      }
      await dispatch(initCashConnect(walletId)).unwrap();
      await dispatch(pairCashConnectThunk(nextUri)).unwrap();
      await Toast.show({ text: 'CashConnect pairing started.' });
      setUri('');
    } catch (error) {
      await Toast.show({ text: toErrorMessage(error) });
    } finally {
      setSubmitting(false);
    }
  };

  const handleScan = async () => {
    try {
      setScanning(true);
      const result = await scanBarcodeSafely({
        hint: CapacitorBarcodeScannerTypeHint.ALL,
        cameraDirection: 1,
      });
      const scanned = String(result?.ScanResult ?? '').trim();
      if (scanned) {
        setUri(scanned);
        await connectToUri(scanned);
      }
    } catch (error) {
      await Toast.show({ text: getBarcodeScannerErrorMessage(error) });
    } finally {
      setScanning(false);
    }
  };

  return (
    <ConnectionUriScanCard
      label="CashConnect"
      placeholder="bch-cc-v1:…"
      value={uri}
      onChange={setUri}
      onScan={() => void handleScan()}
      onConnect={() => void connectToUri(uri)}
      scanning={scanning}
      submitting={submitting}
    />
  );
}
