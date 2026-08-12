import { useState } from 'react';
import { CapacitorBarcodeScannerTypeHint } from '@capacitor/barcode-scanner';
import { Toast } from '@capacitor/toast';
import { FaCamera } from 'react-icons/fa';
import { useDispatch, useSelector } from 'react-redux';
import type { AppDispatch, RootState } from '../../redux/store';
import { initWizardConnect, wizardConnectPair } from '../../redux/wizardconnectSlice';
import {
  getBarcodeScannerErrorMessage,
  scanBarcodeSafely,
} from '../../utils/barcodeScanner';
import { toErrorMessage } from '../../utils/errorHandling';

function isWizardUri(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized.startsWith('wiz://');
}

function shortenWizardUri(uri: string): string {
  if (uri.length <= 96) return uri;
  return `${uri.slice(0, 48)}...${uri.slice(-24)}`;
}

export default function WizardConnectionManager() {
  const dispatch = useDispatch<AppDispatch>();
  const walletId = useSelector((state: RootState) => state.wallet_id.currentWalletId);
  const manager = useSelector((state: RootState) => state.wizardconnect.manager);
  const [uri, setUri] = useState('');
  const [scanning, setScanning] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [pendingUri, setPendingUri] = useState<string | null>(null);

  const connectToUri = async (value: string) => {
    const nextUri = value.trim();
    if (!isWizardUri(nextUri)) {
      await Toast.show({ text: 'Please provide a valid WizardConnect URI' });
      return;
    }

    if (submitting) return;
    setSubmitting(true);

    try {
      if (!walletId || walletId <= 0) {
        throw new Error('No active wallet is available for WizardConnect');
      }

      if (!manager) {
        await dispatch(initWizardConnect(walletId)).unwrap();
      }

      await dispatch(wizardConnectPair(nextUri)).unwrap();
      await Toast.show({ text: 'WizardConnect pairing started.' });
      setUri('');
      setPendingUri(null);
    } catch (error) {
      console.error('[WizardConnectionManager] Error pairing:', error);
      await Toast.show({ text: `Error: ${toErrorMessage(error)}` });
    } finally {
      setSubmitting(false);
    }
  };

  const requestConnect = async (value: string) => {
    const nextUri = value.trim();
    if (!isWizardUri(nextUri)) {
      await Toast.show({ text: 'Please provide a valid WizardConnect URI' });
      return;
    }

    setPendingUri(nextUri);
  };

  const handleScan = async () => {
    try {
      setScanning(true);
      const result = await scanBarcodeSafely({
        hint: CapacitorBarcodeScannerTypeHint.ALL,
        cameraDirection: 1,
      });

      const scanned = result?.ScanResult?.trim() ?? '';
      if (!scanned) {
        await Toast.show({ text: 'No QR code detected. Try again.' });
        return;
      }

      if (!isWizardUri(scanned)) {
        await Toast.show({ text: 'Not a valid WizardConnect QR code' });
        return;
      }

      setPendingUri(scanned);
    } catch (error) {
      console.error('[WizardConnectionManager] Scan error:', error);
      await Toast.show({ text: getBarcodeScannerErrorMessage(error) });
    } finally {
      setScanning(false);
    }
  };

  return (
    <div className="space-y-4 p-4 wallet-card">
      <div className="flex flex-col space-y-2">
        <label className="font-bold">Enter WizardConnect URI:</label>
        <input
          className="wallet-input"
          placeholder="wiz://..."
          value={uri}
          onChange={(event) => setUri(event.target.value)}
        />
        <button
          onClick={handleScan}
          className="wallet-btn-primary py-2 px-4 flex items-center justify-center"
          disabled={scanning || submitting}
        >
          <FaCamera className="mr-2" />
          {scanning ? 'Scanning...' : 'Scan QR'}
        </button>
        <button
          onClick={() => void requestConnect(uri)}
          className="wallet-btn-primary"
          disabled={submitting}
        >
          Connect
        </button>
      </div>

      {pendingUri && (
        <div className="wallet-popup-backdrop">
          <div className="wallet-popup-panel max-w-md w-full space-y-4">
            <h3 className="text-2xl font-bold text-center">Approve WizardConnect</h3>
            <div className="text-center space-y-2">
              <p className="wallet-text-strong">
                Connect this wallet to the following WizardConnect request?
              </p>
              <div className="wallet-surface-strong border border-[var(--wallet-border)] rounded p-3 text-left">
                <div className="text-xs uppercase tracking-wide wallet-muted mb-1">Connection URI</div>
                <div className="font-mono text-sm break-all wallet-text-strong">
                  {shortenWizardUri(pendingUri)}
                </div>
              </div>
            </div>
            <div className="flex justify-around pt-2">
              <button
                onClick={() => void connectToUri(pendingUri)}
                className="wallet-btn-primary px-4 py-2"
                disabled={submitting}
              >
                {submitting ? 'Connecting...' : 'Approve'}
              </button>
              <button
                onClick={() => setPendingUri(null)}
                className="wallet-btn-danger px-4 py-2"
                disabled={submitting}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
