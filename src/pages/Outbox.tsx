import { useSelector } from 'react-redux';
import PageHeader from '../components/ui/PageHeader';
import { selectWalletId } from '../redux/walletSlice';
import useOutboundTransactions from '../hooks/useOutboundTransactions';
import EmptyState from '../components/ui/EmptyState';
import { OUTBOUND_RELEASE_DELAY_MS } from '../services/OutboundTransactionTracker';

function relativeAge(timestamp?: string | null): string {
  if (!timestamp) return 'just now';
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) return 'just now';
  const diffMs = Date.now() - parsed;
  const mins = Math.max(0, Math.floor(diffMs / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export default function Outbox() {
  const walletId = useSelector(selectWalletId);
  const {
    outboundTransactions,
    canClear,
    reconciling,
    refresh,
    release,
  } = useOutboundTransactions(walletId);

  return (
    <div className="container mx-auto max-w-md p-4 pb-16 wallet-page">
      <PageHeader title="Outbox" compact />

      <div className="wallet-card p-4 mt-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="font-semibold wallet-text-strong">
              Pending outgoing transactions
            </div>
            <div className="text-sm wallet-muted mt-1">
              Offline-first protection keeps new sends paused until these transactions are seen or safely released.
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              void refresh();
            }}
            disabled={reconciling}
            className="wallet-btn-secondary px-3 py-2 text-sm shrink-0"
          >
            {reconciling ? 'Syncing' : 'Sync'}
          </button>
        </div>
      </div>

      <div className="mt-3">
        {outboundTransactions.length === 0 ? (
          <EmptyState message="No pending outgoing transactions." />
        ) : (
          <div className="space-y-3">
            {outboundTransactions.map((record) => (
              <div key={record.txid} className="wallet-card p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-semibold wallet-text-strong">
                      {record.sourceLabel || 'Wallet send'}
                    </div>
                    <div className="text-xs wallet-muted mt-1">
                      Updated {relativeAge(record.updatedAt)}
                    </div>
                  </div>
                  <div className="text-xs wallet-muted capitalize">
                    {record.state.replaceAll('_', ' ')}
                  </div>
                </div>

                <div className="mt-3 space-y-2 text-sm">
                  <div>
                    <div className="text-xs wallet-muted">Txid</div>
                    <div className="font-mono wallet-text-strong break-all">
                      {record.txid}
                    </div>
                  </div>

                  {record.recipientSummary && (
                    <div>
                      <div className="text-xs wallet-muted">Destination</div>
                      <div className="wallet-text-strong">{record.recipientSummary}</div>
                    </div>
                  )}

                  {record.amountSummary && (
                    <div>
                      <div className="text-xs wallet-muted">Amount</div>
                      <div className="wallet-text-strong">{record.amountSummary}</div>
                    </div>
                  )}

                  {record.dappName && (
                    <div>
                      <div className="text-xs wallet-muted">Requested by</div>
                      <div className="wallet-text-strong">
                        {record.dappName}
                        {record.dappUrl ? ` (${record.dappUrl})` : ''}
                      </div>
                    </div>
                  )}

                  {record.userPrompt && (
                    <div>
                      <div className="text-xs wallet-muted">Prompt</div>
                      <div className="wallet-text-strong">{record.userPrompt}</div>
                    </div>
                  )}

                  {record.lastError && (
                    <div>
                      <div className="text-xs wallet-muted">Last network issue</div>
                      <div className="wallet-text-strong">
                        {record.lastError}
                      </div>
                    </div>
                  )}
                </div>

                <div className="mt-4 flex items-center justify-between gap-3">
                  <button
                    type="button"
                    onClick={() => navigator.clipboard.writeText(record.txid)}
                    className="wallet-btn-secondary px-3 py-2 text-sm"
                  >
                    Copy txid
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      void release(record.txid);
                    }}
                    disabled={!canClear(record.txid)}
                    className="wallet-btn-secondary px-3 py-2 text-sm"
                    title={
                      record.state === 'submitted'
                        ? 'Clear this pending lock if the transaction was not actually sent'
                        : `Available after ${Math.round(
                            OUTBOUND_RELEASE_DELAY_MS / 60000
                          )} minutes if the transaction is still unresolved`
                    }
                  >
                    {record.state === 'submitted'
                      ? 'Clear pending lock'
                      : 'Release if stale'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
