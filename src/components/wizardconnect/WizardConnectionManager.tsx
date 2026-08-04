import { useState } from 'react';
import { CapacitorBarcodeScannerTypeHint } from '@capacitor/barcode-scanner';
import { Toast } from '@capacitor/toast';
import { useDispatch, useSelector } from 'react-redux';
import type { AppDispatch, RootState } from '../../state/store';
import {
  initWizardConnect,
  wizardConnectPair,
} from '../../state/slices/wizardconnectSlice';
import {
  getBarcodeScannerErrorMessage,
  scanBarcodeSafely,
} from '../../utils/barcodeScanner';
import { toErrorMessage } from '../../utils/errorHandling';
import ConnectionUriScanCard from '../connect/ConnectionUriScanCard';
import { useI18n } from '../../i18n/useI18n';

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
  const { t } = useI18n();
  const walletId = useSelector(
    (state: RootState) => state.wallet_id.currentWalletId
  );
  const manager = useSelector(
    (state: RootState) => state.wizardconnect.manager
  );
  const [uri, setUri] = useState('');
  const [scanning, setScanning] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [pendingUri, setPendingUri] = useState<string | null>(null);

  const connectToUri = async (value: string) => {
    const nextUri = value.trim();
    if (!isWizardUri(nextUri)) {
      await Toast.show({ text: t('wizard.validUri') });
      return;
    }

    if (submitting) return;
    setSubmitting(true);

    try {
      if (!walletId || walletId <= 0) {
        throw new Error(t('wizard.noWallet'));
      }

      if (!manager) {
        await dispatch(initWizardConnect(walletId)).unwrap();
      }

      await dispatch(wizardConnectPair(nextUri)).unwrap();
      await Toast.show({ text: t('wizard.pairingStarted') });
      setUri('');
      setPendingUri(null);
    } catch (error) {
      console.error('[WizardConnectionManager] Error pairing:', error);
      await Toast.show({
        text: t('wizard.errorPrefix', { message: toErrorMessage(error) }),
      });
    } finally {
      setSubmitting(false);
    }
  };

  const requestConnect = async (value: string) => {
    const nextUri = value.trim();
    if (!isWizardUri(nextUri)) {
      await Toast.show({ text: t('wizard.validUri') });
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
        await Toast.show({ text: t('wizard.noQr') });
        return;
      }

      if (!isWizardUri(scanned)) {
        await Toast.show({ text: t('wizard.invalidQr') });
        return;
      }

      setPendingUri(scanned);
    } catch (error) {
      console.error('[WizardConnectionManager] Scan error:', error);
      await Toast.show({
        text: `${t('wizard.scanFailed')} ${getBarcodeScannerErrorMessage(error)}`,
      });
    } finally {
      setScanning(false);
    }
  };

  return (
    <div className="space-y-4">
      <ConnectionUriScanCard
        label={t('wizard.enterUri')}
        placeholder="wiz://..."
        value={uri}
        onChange={setUri}
        onScan={handleScan}
        onConnect={() => void requestConnect(uri)}
        scanning={scanning}
        submitting={submitting}
        connectLabel={t('wizard.connect')}
      />

      {pendingUri && (
        <div className="wallet-popup-backdrop">
          <div className="wallet-popup-panel max-w-md w-full space-y-5">
            <h3 className="text-2xl font-bold text-center">
              {t('wizard.approve')}
            </h3>
            <div className="text-center space-y-3">
              <p className="wallet-text-strong">
                {t('wizard.connectQuestion')}
              </p>
              <div className="wallet-surface-strong border border-[var(--wallet-border)] rounded-2xl p-4 text-left">
                <div className="text-[11px] uppercase tracking-[0.18em] wallet-muted mb-1">
                  {t('wizard.connectionUri')}
                </div>
                <div className="font-mono text-sm break-all wallet-text-strong leading-relaxed">
                  {shortenWizardUri(pendingUri)}
                </div>
              </div>
            </div>
            <div className="flex justify-around gap-3 pt-1">
              <button
                onClick={() => void connectToUri(pendingUri)}
                className="wallet-btn-primary px-4 py-2"
                disabled={submitting}
              >
                {submitting ? t('wizard.connecting') : t('wizard.approve')}
              </button>
              <button
                onClick={() => setPendingUri(null)}
                className="wallet-btn-danger px-4 py-2"
                disabled={submitting}
              >
                {t('wizard.cancel')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
