import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import OutboundTransactionTracker, {
  type OutboundTransactionRecord,
} from '../../../services/OutboundTransactionTracker';
import WalletTooltip from '../../../components/ui/WalletTooltip';
import { shortenTxHash } from '../../../utils/shortenHash';
import { useI18n } from '../../../i18n/useI18n';
import type { TranslationKey } from '../../../i18n/resources';

type PendingOutboundPanelProps = {
  records: OutboundTransactionRecord[];
  refreshing?: boolean;
  onRefresh?: () => void;
  onRelease?: (txid: string) => void;
  onClose?: () => void;
  compact?: boolean;
};

function stateLabel(
  record: OutboundTransactionRecord,
  t: (key: TranslationKey) => string
): string {
  switch (record.state) {
    case 'broadcasted':
      return t('home.syncing');
    case 'submitted':
      return t('history.awaitingConfirmation');
    case 'broadcasting':
      return t('send.sending');
    default:
      return t('send.pending');
  }
}

export default function PendingOutboundPanel({
  records,
  refreshing = false,
  onRefresh,
  onRelease,
  onClose,
  compact = false,
}: PendingOutboundPanelProps) {
  const { t } = useI18n();
  if (records.length === 0) return null;
  if (typeof document === 'undefined') return null;

  const visible = compact ? records.slice(0, 1) : records.slice(0, 3);

  return createPortal(
    <div
      className="wallet-popup-backdrop z-[1200] p-3 sm:p-4"
      role="presentation"
      onClick={onClose}
    >
      <div
        className="wallet-popup-panel flex w-full max-w-xl flex-col overflow-hidden p-4 sm:p-5"
        style={{
          maxHeight: 'calc(100dvh - var(--safe-bottom) - 1rem)',
        }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="pending-outbound-panel-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 flex-1">
            <div
              id="pending-outbound-panel-title"
              className="text-sm font-semibold wallet-text-strong"
            >
              {records.length === 1
                ? t('outbox.finalizing')
                : t('outbox.finalizingMultiple', { count: records.length })}
            </div>
            <div className="text-xs wallet-muted mt-1">
              {t('outbox.historyUpdate')}
            </div>
          </div>
          {onRefresh && (
            <div className="flex shrink-0 items-center gap-2">
              <Link
                to="/outbox"
                className="wallet-btn-secondary px-3 py-1.5 text-xs"
              >
                {t('outbox.title')}
              </Link>
              <button
                type="button"
                onClick={onRefresh}
                disabled={refreshing}
                className="wallet-btn-secondary px-3 py-1.5 text-xs"
              >
                {refreshing ? t('home.syncing') : t('home.sync')}
              </button>
            </div>
          )}
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="wallet-btn-secondary px-3 py-1.5 text-xs"
              aria-label={t('outbox.dismissPending')}
              title={t('outbox.dismiss')}
            >
              {t('outbox.dismiss')}
            </button>
          )}
        </div>

        <div className="mt-4 min-h-0 space-y-2 overflow-y-auto pr-1">
          {visible.map((record) => (
            <div
              key={record.txid}
              className="rounded-xl border border-[var(--wallet-border)] px-3 py-2"
            >
              <div className="flex items-center justify-between gap-3">
                <div
                  className="cursor-pointer font-mono text-sm wallet-text-strong"
                  data-tooltip-id={`txid-tooltip-${record.txid}`}
                  data-tooltip-content={record.txid}
                >
                  {shortenTxHash(record.txid)}
                </div>
                <WalletTooltip
                  id={`txid-tooltip-${record.txid}`}
                  place="top"
                  clickable={true}
                  content={record.txid}
                />
                <div className="text-[11px] wallet-muted">
                  {stateLabel(record, t)}
                </div>
              </div>
              {onRelease && OutboundTransactionTracker.canRelease(record) && (
                <div className="mt-2 flex justify-end">
                  <button
                    type="button"
                    onClick={() => onRelease(record.txid)}
                    className="wallet-btn-secondary px-2.5 py-1 text-[11px]"
                  >
                    {t('outbox.releaseSendLock')}
                  </button>
                </div>
              )}
              {onRelease &&
                !OutboundTransactionTracker.canRelease(record) &&
                OutboundTransactionTracker.canClear(record) && (
                  <div className="mt-2 flex justify-end">
                    <button
                      type="button"
                      onClick={() => onRelease(record.txid)}
                      className="wallet-btn-secondary px-2.5 py-1 text-[11px]"
                    >
                      {t('outbox.clearPending')}
                    </button>
                  </div>
                )}
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body
  );
}
