import { shortenTxHash } from '../../utils/shortenHash';
import OutboundTransactionTracker, {
  type OutboundTransactionRecord,
} from '../../services/OutboundTransactionTracker';
import { Link } from 'react-router-dom';
import WalletTooltip from '../ui/WalletTooltip';

type PendingOutboundPanelProps = {
  records: OutboundTransactionRecord[];
  refreshing?: boolean;
  onRefresh?: () => void;
  onRelease?: (txid: string) => void;
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
  compact = false,
}: PendingOutboundPanelProps) {
  if (records.length === 0) return null;

  const visible = compact ? records.slice(0, 1) : records.slice(0, 3);

  return (
    <div className="wallet-card p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold wallet-text-strong">
            {records.length === 1
              ? 'Outgoing transaction still syncing'
              : `${records.length} outgoing transactions still syncing`}
          </div>
          <div className="text-xs wallet-muted mt-1">
            To prevent accidental repeats, new sends stay locked until these
            appear in your wallet history.
          </div>
        </div>
        {onRefresh && (
          <div className="flex items-center gap-2 shrink-0">
            <Link
              to="/outbox"
              className="wallet-btn-secondary px-3 py-1.5 text-xs"
            >
              Outbox
            </Link>
            <button
              type="button"
              onClick={onRefresh}
              disabled={refreshing}
              className="wallet-btn-secondary px-3 py-1.5 text-xs"
            >
              {refreshing ? 'Syncing' : 'Sync'}
            </button>
          </div>
        )}
      </div>

      <div className="mt-3 space-y-2">
        {visible.map((record) => (
          <div
            key={record.txid}
            className="rounded-xl border border-[var(--wallet-border)] px-3 py-2"
          >
            <div className="flex items-center justify-between gap-3">
              <div
                className="font-mono text-sm wallet-text-strong cursor-pointer"
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
  );
}
