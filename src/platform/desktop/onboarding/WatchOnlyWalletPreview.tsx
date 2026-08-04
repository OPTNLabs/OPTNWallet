import { useState, type FC } from 'react';

import { Network } from '../../../state/slices/networkSlice';
import {
  deriveWatchOnlyAccountPreview,
  type WatchOnlyAccountPreview,
} from './watchOnlyAccountPreview';
import { CapacitorBarcodeScanner } from '../barcode-scanner';
import { CameraQrScanner } from '../CameraQrScanner';
import { useI18n } from '../../../i18n/useI18n';

type WatchOnlyWalletPreviewProps = {
  onBack: () => void;
};

export const WatchOnlyWalletPreview: FC<WatchOnlyWalletPreviewProps> = ({
  onBack,
}) => {
  const { t } = useI18n();
  const [network, setNetwork] = useState(Network.MAINNET);
  const [accountXpub, setAccountXpub] = useState('');
  const [preview, setPreview] = useState<WatchOnlyAccountPreview | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState('');

  const handlePreview = () => {
    try {
      setPreview(deriveWatchOnlyAccountPreview(network, accountXpub));
      setError('');
    } catch (err) {
      setPreview(null);
      setError(
        err instanceof Error ? err.message : 'Could not preview this xPub.'
      );
    }
  };

  return (
    <section className="min-h-[100dvh] wallet-surface flex flex-col items-center px-4 py-10">
      <div className="w-full max-w-md space-y-4">
        <div className="space-y-1 text-center">
          <h1 className="text-xl font-bold wallet-text-strong">
            {t('watchOnly.title')}
          </h1>
          <p className="text-sm wallet-muted">{t('watchOnly.description')}</p>
        </div>

        <div
          className="grid grid-cols-2 gap-2"
          aria-label={t('watchOnly.type')}
        >
          <div className="wallet-card border-[var(--wallet-accent)] p-3">
            <p className="text-sm font-semibold wallet-text-strong">
              {t('watchOnly.standard')}
            </p>
            <p className="mt-1 text-[11px] wallet-muted">
              {t('watchOnly.accountXpub')}
            </p>
          </div>
          <div className="wallet-card p-3 opacity-60" aria-disabled="true">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-semibold wallet-text-strong">
                {t('watchOnly.multisign')}
              </p>
              <span className="text-[9px] wallet-muted">
                {t('watchOnly.comingNext')}
              </span>
            </div>
            <p className="mt-1 text-[11px] wallet-muted">
              {t('watchOnly.multipleCosigners')}
            </p>
          </div>
        </div>

        <div className="wallet-card space-y-3 p-4">
          <label className="block space-y-1 text-sm wallet-text-strong">
            {t('watchOnly.network')}
            <select
              value={network}
              onChange={(event) => {
                setNetwork(event.target.value as Network);
                setPreview(null);
                setError('');
              }}
              className="wallet-input w-full rounded-md px-3 py-2"
            >
              <option value={Network.MAINNET}>{t('watchOnly.mainnet')}</option>
              <option value={Network.CHIPNET}>{t('watchOnly.chipnet')}</option>
            </select>
          </label>
          <label className="block space-y-1 text-sm wallet-text-strong">
            {t('watchOnly.accountXpub')}
            <textarea
              value={accountXpub}
              onChange={(event) => {
                setAccountXpub(event.target.value);
                setPreview(null);
                setError('');
              }}
              rows={3}
              autoComplete="off"
              spellCheck={false}
              placeholder={t('watchOnly.xpubPlaceholder')}
              className="wallet-input w-full resize-none rounded-md px-3 py-2 font-mono text-xs"
            />
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setScanning(true)}
              className="flex-1 rounded-md border border-[var(--wallet-border)] py-2 text-sm font-semibold wallet-text-strong"
            >
              {t('watchOnly.scanCamera')}
            </button>
            <button
              type="button"
              onClick={async () => {
                try {
                  const { ScanResult } =
                    await CapacitorBarcodeScanner.scanBarcode();
                  if (ScanResult) {
                    setAccountXpub(ScanResult.trim());
                    setPreview(null);
                    setError('');
                  }
                } catch (err) {
                  if (
                    err instanceof Error &&
                    err.message !== 'No file selected'
                  ) {
                    setError(err.message);
                  }
                }
              }}
              className="flex-1 rounded-md border border-[var(--wallet-border)] py-2 text-sm font-semibold wallet-text-strong"
            >
              {t('watchOnly.uploadQr')}
            </button>
          </div>
          {scanning && (
            <CameraQrScanner
              onResult={(text) => {
                setAccountXpub(text);
                setPreview(null);
                setError('');
                setScanning(false);
              }}
              onClose={() => setScanning(false)}
            />
          )}
          <p className="text-[11px] leading-relaxed wallet-muted">
            {t('watchOnly.pathNote')}
          </p>
          <button
            type="button"
            onClick={handlePreview}
            className="wallet-btn-primary w-full py-2 font-semibold"
          >
            {t('watchOnly.previewPublic')}
          </button>
          {error && (
            <p role="alert" className="text-xs text-red-400">
              {error}
            </p>
          )}
        </div>

        {preview && (
          <div className="wallet-card space-y-3 p-4">
            <p className="text-sm font-semibold wallet-text-strong">
              {t('watchOnly.previewTitle')}
            </p>
            {(
              [
                ['watchOnly.receive', preview.receive],
                ['watchOnly.change', preview.change],
              ] as const
            ).map(([label, item]) => (
              <div key={label} className="space-y-1">
                <p className="text-[11px] wallet-muted">
                  {t(label, { index: 0 })} ·{' '}
                  <span className="font-mono">{item.path}</span>
                </p>
                <p className="break-all font-mono text-xs wallet-text-strong">
                  {item.address}
                </p>
              </div>
            ))}
          </div>
        )}

        <div className="rounded-xl border border-amber-400/30 bg-amber-400/5 p-3 text-xs leading-relaxed text-amber-300">
          {t('watchOnly.warning')}
        </div>
        <button
          type="button"
          onClick={onBack}
          className="wallet-btn-secondary w-full py-2 text-sm"
        >
          {t('watchOnly.back')}
        </button>
      </div>
    </section>
  );
};
