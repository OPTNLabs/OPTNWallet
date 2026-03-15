import { useEffect, useMemo, useState } from 'react';
import Popup from '../../components/transaction/Popup';
import StatusChip from '../../components/ui/StatusChip';
import type {
  TransactionDetails,
  TransactionDetailParticipant,
} from '../../types/types';
import ElectrumService from '../../services/ElectrumService';

type Props = {
  txid: string;
  txHeight: number;
  explorerUrl: string;
  walletAddresses: Set<string>;
  onClose: () => void;
};

const SATS_PER_BCH = 100_000_000;

function formatSats(amountSats?: number): string {
  if (amountSats == null || !Number.isFinite(amountSats)) return 'Unknown';
  return `${(amountSats / SATS_PER_BCH).toFixed(8).replace(/\.?0+$/, '')} BCH`;
}

function formatTimestamp(timestamp?: string): string {
  if (!timestamp) return 'Unavailable';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return 'Unavailable';
  return date.toLocaleString();
}

function markWalletParticipants(
  rows: TransactionDetailParticipant[],
  walletAddresses: Set<string>
): TransactionDetailParticipant[] {
  return rows.map((row) => ({
    ...row,
    isWalletAddress: walletAddresses.has(row.address),
  }));
}

function Section({
  title,
  rows,
}: {
  title: string;
  rows: TransactionDetailParticipant[];
}) {
  return (
    <section className="wallet-card p-4">
      <div className="flex items-center justify-between gap-2 mb-3">
        <h3 className="text-sm font-semibold wallet-text-strong">{title}</h3>
        <span className="text-xs wallet-muted">{rows.length}</span>
      </div>

      <div className="space-y-3">
        {rows.length === 0 ? (
          <div className="text-sm wallet-muted">No data available.</div>
        ) : (
          rows.map((row, index) => (
            <div
              key={`${row.address}-${row.outputIndex ?? index}`}
              className="rounded-2xl border border-[var(--wallet-border)] p-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-mono text-xs break-all wallet-text-strong">
                    {row.address}
                  </div>
                  {typeof row.outputIndex === 'number' ? (
                    <div className="text-xs wallet-muted mt-1">
                      Output #{row.outputIndex}
                    </div>
                  ) : null}
                </div>
                {row.isWalletAddress ? (
                  <StatusChip tone="neutral">Your wallet</StatusChip>
                ) : null}
              </div>
              <div className="text-sm mt-2 wallet-text-strong">
                {formatSats(row.amountSats)}
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

export default function TransactionDetailPopup({
  txid,
  txHeight,
  explorerUrl,
  walletAddresses,
  onClose,
}: Props) {
  const [details, setDetails] = useState<TransactionDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError('');
      try {
        const next = await ElectrumService.getTransactionDetails(txid);
        if (!cancelled) {
          setDetails(next);
          if (!next)
            setError(
              'Transaction details are not available from Electrum right now.'
            );
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error
              ? err.message
              : 'Failed to load transaction details.'
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [txid]);

  const markedInputs = useMemo(
    () => markWalletParticipants(details?.inputs ?? [], walletAddresses),
    [details?.inputs, walletAddresses]
  );
  const markedOutputs = useMemo(
    () => markWalletParticipants(details?.outputs ?? [], walletAddresses),
    [details?.outputs, walletAddresses]
  );

  return (
    <Popup closePopups={onClose} closeButtonText="Close details">
      <div className="space-y-4 p-1">
        <div>
          <div className="text-xs wallet-muted mb-1">Transaction</div>
          <div className="font-mono text-sm break-all wallet-text-strong">
            {txid}
          </div>
        </div>

        <section className="wallet-card p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-xs wallet-muted mb-1">Status</div>
              <div className="text-sm wallet-text-strong">
                {details?.confirmations || txHeight > 0
                  ? `${details?.confirmations ?? 1} confirmation${(details?.confirmations ?? 1) === 1 ? '' : 's'}`
                  : 'Pending'}
              </div>
            </div>
            {details?.confirmations || txHeight > 0 ? (
              <StatusChip tone="success">Confirmed</StatusChip>
            ) : (
              <StatusChip tone="warning">Pending</StatusChip>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3 mt-4 text-sm">
            <div>
              <div className="text-xs wallet-muted">Block</div>
              <div className="wallet-text-strong">
                {details?.height ?? (txHeight > 0 ? txHeight : 'Unconfirmed')}
              </div>
            </div>
            <div>
              <div className="text-xs wallet-muted">Fee</div>
              <div className="wallet-text-strong">
                {formatSats(details?.feeSats)}
              </div>
            </div>
            <div className="col-span-2">
              <div className="text-xs wallet-muted">Timestamp</div>
              <div className="wallet-text-strong">
                {formatTimestamp(details?.timestamp)}
              </div>
            </div>
            <div className="col-span-2">
              <a
                href={explorerUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm underline wallet-text-strong"
              >
                Open in explorer
              </a>
            </div>
          </div>
        </section>

        {loading ? (
          <div className="wallet-card p-4 text-sm wallet-muted">
            Loading transaction details…
          </div>
        ) : error ? (
          <div className="wallet-card p-4 text-sm wallet-muted">{error}</div>
        ) : (
          <>
            <Section title="Senders" rows={markedInputs} />
            <Section title="Recipients" rows={markedOutputs} />
          </>
        )}
      </div>
    </Popup>
  );
}
