import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import OutboundTransactionTracker, {
  OUTBOUND_RELEASE_DELAY_MS,
  isFusionVerificationPending,
  type OutboundTransactionRecord,
} from '../../../services/OutboundTransactionTracker';
import { useI18n } from '../../../i18n/useI18n';
import type { TranslationKey } from '../../../i18n/resources';
import MaskedValue from '../../../components/ui/MaskedValue';
import InfoButton from '../../../components/ui/InfoButton';

type PendingOutboundPanelProps = {
  records: OutboundTransactionRecord[];
  refreshing?: boolean;
  onRefresh?: () => void;
  onRelease?: (txid: string) => void;
  onClose?: () => void;
  compact?: boolean;
  blocking?: boolean;
};

function stateLabel(
  record: OutboundTransactionRecord,
  t: (key: TranslationKey) => string
): string {
  if (isFusionVerificationPending(record)) {
    return t('outbox.awaitingVerification');
  }
  switch (record.state) {
    case 'broadcasted':
      return t('outbox.stateBroadcasted');
    case 'submitted':
      return t('outbox.stateSubmitted');
    case 'broadcasting':
      return t('outbox.stateBroadcasting');
    default:
      return t('outbox.stateSeen');
  }
}

function stateHelp(
  record: OutboundTransactionRecord,
  t: (key: TranslationKey) => string
): string {
  if (isFusionVerificationPending(record)) {
    return t('outbox.verificationWaitDescription');
  }
  switch (record.state) {
    case 'broadcasting':
      return t('outbox.stateBroadcastingHelp');
    case 'submitted':
      return t('outbox.stateSubmittedHelp');
    case 'broadcasted':
      return t('outbox.stateBroadcastedHelp');
    case 'seen':
      return t('outbox.stateSeenHelp');
  }
}

export default function PendingOutboundPanel({
  records,
  refreshing = false,
  onRefresh,
  onRelease,
  onClose,
  compact = false,
  blocking = true,
}: PendingOutboundPanelProps) {
  const { t } = useI18n();
  if (records.length === 0) return null;
  if (typeof document === 'undefined') return null;

  const visible = compact ? records.slice(0, 1) : records.slice(0, 3);

  return createPortal(
    <div
      className={`wallet-popup-backdrop z-[1200] p-3 sm:p-4${
        blocking ? '' : ' wallet-popup-backdrop--non-blocking'
      }`}
      role="presentation"
      onClick={onClose}
    >
      <div
        className="wallet-popup-panel flex w-full max-w-xl flex-col overflow-hidden p-4 sm:p-5"
        style={{
          maxHeight: 'calc(100dvh - var(--safe-bottom) - 1rem)',
        }}
        role={blocking ? 'dialog' : 'status'}
        aria-modal={blocking ? true : undefined}
        aria-live={blocking ? undefined : 'polite'}
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
                className="wallet-btn-secondary min-h-[44px] px-3 py-2 text-xs"
              >
                {t('outbox.title')}
              </Link>
              <button
                type="button"
                onClick={onRefresh}
                disabled={refreshing}
                className="wallet-btn-secondary min-h-[44px] px-3 py-2 text-xs"
              >
                {refreshing ? t('home.syncing') : t('home.sync')}
              </button>
            </div>
          )}
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="wallet-btn-secondary min-h-[44px] px-3 py-2 text-xs"
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
                <div className="min-w-0">
                  <MaskedValue
                    value={record.txid}
                    label={t('history.transactionId')}
                    ariaLabel={t('history.transactionId')}
                    copySuccessMessageKey="history.transactionCopied"
                    embedded
                    className="max-w-[13rem] truncate text-sm"
                  />
                </div>
                <div className="flex shrink-0 items-center gap-0.5 text-[11px] wallet-muted">
                  <span>{stateLabel(record, t)}</span>
                  <InfoButton
                    id={`pending-outbound-state-${record.txid}`}
                    ariaLabel={t('outbox.stateHelpLabel')}
                    content={stateHelp(record, t)}
                  />
                </div>
              </div>
              {isFusionVerificationPending(record) ? (
                <p className="mt-2 rounded-lg border border-[var(--wallet-border)] bg-[var(--wallet-surface-strong)] px-3 py-2 text-xs leading-snug wallet-muted">
                  {t('outbox.verificationWaitDescription')}
                </p>
              ) : null}
              {onRelease && OutboundTransactionTracker.canRelease(record) && (
                <div className="mt-2 flex items-center justify-end gap-1">
                  <button
                    type="button"
                    onClick={() => onRelease(record.txid)}
                    className="wallet-btn-secondary min-h-[44px] px-3 py-2 text-xs"
                  >
                    {t('outbox.releaseSendLock')}
                  </button>
                  <InfoButton
                    id={`pending-outbound-release-${record.txid}`}
                    ariaLabel={t('outbox.releaseHelpLabel')}
                    content={t('outbox.releaseStaleTitle', {
                      minutes: Math.round(OUTBOUND_RELEASE_DELAY_MS / 60000),
                    })}
                  />
                </div>
              )}
              {onRelease &&
                !OutboundTransactionTracker.canRelease(record) &&
                OutboundTransactionTracker.canClear(record) && (
                  <div className="mt-2 flex items-center justify-end gap-1">
                    <button
                      type="button"
                      onClick={() => onRelease(record.txid)}
                      className="wallet-btn-secondary min-h-[44px] px-3 py-2 text-xs"
                    >
                      {t('outbox.clearPending')}
                    </button>
                    <InfoButton
                      id={`pending-outbound-clear-${record.txid}`}
                      ariaLabel={t('outbox.releaseHelpLabel')}
                      content={t('outbox.clearPendingTitle')}
                    />
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
