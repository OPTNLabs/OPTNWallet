import { useCallback, useEffect, useMemo, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import Popup from '../../components/transaction/Popup';
import StatusChip from '../../components/ui/StatusChip';
import type {
  TransactionDetails,
  TransactionDetailParticipant,
} from '../../types/types';
import ElectrumService from '../../services/ElectrumService';
import TransactionManager from '../../apis/TransactionManager/TransactionManager';
import {
  getCoinLabel,
  setCoinLabel,
} from '../../platform/desktop/CoinLabelService';
import { addTransactions } from '../../state/slices/transactionSlice';
import { selectWalletId } from '../../state/slices/walletSlice';
import { isTxConfirmed } from '../../utils/txConfirmation';

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
              key={`${title}-${row.address}-${row.outputIndex ?? 'na'}-${index}`}
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
  const walletId = useSelector(selectWalletId);
  const dispatch = useDispatch();
  const [details, setDetails] = useState<TransactionDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [txLabel, setTxLabel] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError('');
      try {
        const next = await ElectrumService.getTransactionDetails(txid, {
          forceRefresh: true,
        });
        if (!cancelled) {
          setDetails(next);
          if (!next)
            setError(
              'Transaction details are not available from Electrum right now.'
            );
          // Write confirmed height back so Home/list stop showing Unconfirmed
          // for fusion rows that were inserted with height 0 at broadcast.
          if (
            next &&
            walletId > 0 &&
            isTxConfirmed(next) &&
            typeof next.height === 'number' &&
            next.height > 0
          ) {
            dispatch(
              addTransactions({
                wallet_id: walletId,
                transactions: [
                  {
                    tx_hash: txid,
                    height: next.height,
                    timestamp: next.timestamp,
                  },
                ],
              })
            );
            void TransactionManager()
              .applyConfirmedHeight(
                walletId,
                txid,
                next.height,
                next.timestamp
              )
              .catch(() => undefined);
          }
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
  }, [txid, walletId, dispatch]);

  useEffect(() => {
    if (walletId <= 0 || !txid) {
      setTxLabel(null);
      return;
    }
    let cancelled = false;
    void getCoinLabel(walletId, 'txid', txid).then((label) => {
      if (!cancelled) setTxLabel(label);
    });
    return () => {
      cancelled = true;
    };
  }, [walletId, txid]);

  const editTxLabel = useCallback(async () => {
    if (walletId <= 0) return;
    const next = window.prompt(
      'Label this transaction (empty to clear). Personal note only.',
      txLabel ?? ''
    );
    if (next === null) return;
    await setCoinLabel(walletId, 'txid', txid, next);
    const cleaned = next.trim();
    setTxLabel(cleaned ? cleaned.slice(0, 200) : null);
  }, [walletId, txid, txLabel]);

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
          {walletId > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
              <span className="text-xs wallet-muted">Label</span>
              <span className="wallet-text-strong">
                {txLabel || (
                  <span className="wallet-muted italic">none</span>
                )}
              </span>
              <button
                type="button"
                className="text-xs underline wallet-muted hover:wallet-text-strong"
                onClick={() => void editTxLabel()}
              >
                Edit
              </button>
            </div>
          )}
        </div>

        <section className="wallet-card p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-xs wallet-muted mb-1">Status</div>
              <div className="text-sm wallet-text-strong">
                {loading
                  ? 'Loading…'
                  : isTxConfirmed({
                        confirmations: details?.confirmations,
                        height: details?.height ?? txHeight,
                      })
                    ? `${details?.confirmations ?? 1} confirmation${
                        (details?.confirmations ?? 1) === 1 ? '' : 's'
                      }`
                    : 'Unconfirmed'}
              </div>
            </div>
            {loading ? (
              <StatusChip tone="neutral">Loading</StatusChip>
            ) : isTxConfirmed({
                confirmations: details?.confirmations,
                height: details?.height ?? txHeight,
              }) ? (
              <StatusChip tone="success">Confirmed</StatusChip>
            ) : (
              <StatusChip tone="warning">Unconfirmed</StatusChip>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3 mt-4 text-sm">
            <div>
              <div className="text-xs wallet-muted">Block</div>
              <div className="wallet-text-strong">
                {loading
                  ? '…'
                  : (details?.height ??
                    (txHeight > 0 ? txHeight : 'Unconfirmed'))}
              </div>
            </div>
            <div>
              <div className="text-xs wallet-muted">Fee</div>
              <div className="wallet-text-strong">
                {loading ? '…' : formatSats(details?.feeSats)}
              </div>
            </div>
            <div className="col-span-2">
              <div className="text-xs wallet-muted">Timestamp</div>
              <div className="wallet-text-strong">
                {loading ? '…' : formatTimestamp(details?.timestamp)}
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
