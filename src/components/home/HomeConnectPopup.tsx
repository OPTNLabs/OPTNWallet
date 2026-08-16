import ConnectionUriScanCard from '../connect/ConnectionUriScanCard';
import { useI18n } from '../../i18n/useI18n';

type HomeConnectPopupProps = {
  uri: string;
  onChange: (value: string) => void;
  onScan: () => void;
  onConnect: () => void;
  onClose: () => void;
  scanning?: boolean;
  submitting?: boolean;
};

export default function HomeConnectPopup({
  uri,
  onChange,
  onScan,
  onConnect,
  onClose,
  scanning = false,
  submitting = false,
}: HomeConnectPopupProps) {
  const { t } = useI18n();

  return (
    <div className="wallet-popup-backdrop p-3 sm:p-4">
      <div className="wallet-popup-panel max-w-md w-full space-y-4">
        <div className="space-y-1 text-center">
          <h2 className="text-xl font-bold">{t('wc.connect')}</h2>
          <p className="text-sm wallet-muted">{t('homeConnect.description')}</p>
        </div>
        <ConnectionUriScanCard
          label={t('wc.connectionUri')}
          placeholder={t('homeConnect.placeholder')}
          value={uri}
          onChange={onChange}
          onScan={onScan}
          onConnect={onConnect}
          scanning={scanning}
          submitting={submitting}
        />
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
