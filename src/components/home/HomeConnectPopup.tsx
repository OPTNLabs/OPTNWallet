import { FaCamera } from 'react-icons/fa';
import { useI18n } from '../../i18n/useI18n';
import { QrStreamScanner } from '../qr/QrStreamScanner';

type HomeConnectPopupProps = {
  uri: string;
  onChange: (value: string) => void;
  onScan: () => void;
  onConnect: () => void;
  onClose: () => void;
  scanning?: boolean;
  submitting?: boolean;
  streamScanning?: boolean;
  onStreamScan?: () => void;
  onStreamComplete?: (payload: Uint8Array) => void;
};

export default function HomeConnectPopup({
  uri,
  onChange,
  onScan,
  onConnect,
  onClose,
  scanning = false,
  submitting = false,
  streamScanning = false,
  onStreamScan = () => undefined,
  onStreamComplete = () => undefined,
}: HomeConnectPopupProps) {
  const { t } = useI18n();

  return (
    <div
      className="wallet-popup-backdrop p-3 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="home-scan-title"
    >
      <div className="wallet-popup-panel max-h-[calc(100dvh-7rem)] w-full max-w-md space-y-4 overflow-y-auto pb-[calc(var(--safe-bottom)+1rem)]">
        <div className="space-y-1 text-center">
          <h2 id="home-scan-title" className="text-xl font-bold">
            {t('homeConnect.scanTitle')}
          </h2>
          <p className="text-sm wallet-muted">
            {t('homeConnect.scanDescription')}
          </p>
        </div>

        <button
          type="button"
          onClick={onScan}
          disabled={scanning || submitting}
          className="group relative flex aspect-[1.15] w-full items-center justify-center overflow-hidden rounded-[24px] border-2 border-dashed border-[var(--wallet-accent)] bg-[var(--wallet-surface)] transition hover:bg-[var(--wallet-surface-strong)] disabled:cursor-not-allowed disabled:opacity-70"
          aria-label={t('homeConnect.scanButton')}
        >
          <span className="absolute inset-5 rounded-[18px] border border-[var(--wallet-accent)]/60 opacity-80" />
          <span className="relative flex flex-col items-center gap-3 text-[var(--wallet-accent)]">
            <FaCamera className="text-3xl" aria-hidden="true" />
            <span className="text-sm font-semibold">
              {scanning ? t('qr.scanning') : t('homeConnect.scanButton')}
            </span>
          </span>
        </button>

        {streamScanning ? (
          <div className="wallet-card space-y-3 p-3">
            <QrStreamScanner
              onComplete={onStreamComplete}
              onSinglePayload={(payload) =>
                onStreamComplete(new TextEncoder().encode(payload))
              }
            />
            <button
              type="button"
              className="wallet-btn-secondary w-full"
              onClick={onClose}
            >
              {t('app.close')}
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="wallet-btn-secondary w-full"
            onClick={onStreamScan}
            disabled={scanning || submitting}
          >
            Scan large / streaming QR
          </button>
        )}

        <div className="wallet-card space-y-3 p-4">
          <div className="text-sm font-bold wallet-text-strong">
            {t('homeConnect.enterManually')}
          </div>
          <input
            className="wallet-input w-full"
            data-testid="home-scan-input"
            placeholder={t('homeConnect.manualPlaceholder')}
            value={uri}
            onChange={(event) => onChange(event.target.value)}
            aria-label={t('homeConnect.enterManually')}
          />
          <button
            type="button"
            onClick={onConnect}
            className="wallet-btn-primary w-full"
            data-testid="home-scan-continue"
            disabled={submitting || scanning || !uri.trim()}
          >
            {submitting ? t('wc.working') : t('homeConnect.continue')}
          </button>
        </div>

        <button
          type="button"
          className="wallet-btn-secondary w-full"
          onClick={onClose}
          disabled={scanning || submitting}
        >
          {t('app.close')}
        </button>
      </div>
    </div>
  );
}
