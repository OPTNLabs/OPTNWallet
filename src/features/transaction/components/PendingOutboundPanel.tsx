import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import OutboundTransactionTracker, {
  type OutboundTransactionRecord,
} from '../../../services/OutboundTransactionTracker';
import WalletTooltip from '../../../components/ui/WalletTooltip';
import { shortenTxHash } from '../../../utils/shortenHash';

type PendingOutboundPanelProps = {
  records: OutboundTransactionRecord[];
  refreshing?: boolean;
  onRefresh?: () => void;
  onRelease?: (txid: string) => void;
  onClose?: () => void;
  compact?: boolean;
};

function stateLabel(record: OutboundTransactionRecord): string {
  switch (record.state) {
    case 'broadcasted':
      return 'Broadcasted, syncing wallet';
    case 'submitted':
      return 'Awaiting network visibility';
    case 'broadcasting':
      return 'Sending';
    default:
      return 'Pending';
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
              className="text-sm font-semibold leading-snug wallet-text-strong"
            >
              {records.length === 1
                ? 'Outgoing transaction still syncing'
                : `${records.length} outgoing transactions still syncing`}
            </div>
            <div className="mt-1 text-xs leading-relaxed wallet-muted">
              To prevent accidental repeats, new sends stay locked until these
              appear in your wallet history.
            </div>
          </div>
          {(onRefresh || onClose) && (
            <div className="flex flex-wrap items-center justify-end gap-2 sm:shrink-0">
              {onRefresh && (
                <Link
                  to="/outbox"
                  className="wallet-btn-secondary whitespace-nowrap px-3 py-1.5 text-xs"
                >
                  Outbox
                </Link>
              )}
              {onRefresh && (
                <button
                  type="button"
                  onClick={onRefresh}
                  disabled={refreshing}
                  className="wallet-btn-secondary whitespace-nowrap px-3 py-1.5 text-xs"
                >
                  {refreshing ? 'Syncing' : 'Sync'}
                </button>
              )}
              {onClose && (
                <button
                  type="button"
                  onClick={onClose}
                  className="wallet-btn-secondary whitespace-nowrap px-3 py-1.5 text-xs"
                  aria-label="Dismiss pending transactions popup"
                  title="Dismiss"
                >
                  Dismiss
                </button>
              )}
            </div>
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
                  {stateLabel(record)}
                </div>
              </div>
              {onRelease && OutboundTransactionTracker.canRelease(record) && (
                <div className="mt-2 flex justify-end">
                  <button
                    type="button"
                    onClick={() => onRelease(record.txid)}
                    className="wallet-btn-secondary px-2.5 py-1 text-[11px]"
                  >
                    Release send lock
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
                      Clear pending lock
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
