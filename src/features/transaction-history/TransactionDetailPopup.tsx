import { useEffect, useMemo, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import Popup from '../../components/transaction/Popup';
import StatusChip from '../../components/ui/StatusChip';
import type {
  TransactionDetails,
  TransactionDetailParticipant,
} from '../../types/types';
import ElectrumService from '../../services/ElectrumService';
import TransactionManager from '../../apis/TransactionManager/TransactionManager';
import { addTransactions } from '../../state/slices/transactionSlice';
import { selectWalletId } from '../../state/slices/walletSlice';
import { isTxConfirmed } from '../../utils/txConfirmation';
import { useI18n } from '../../i18n/useI18n';
import { formatDate, formatNumber } from '../../i18n/format';
import type { SupportedLocale } from '../../i18n/types';
import { copyWithFeedback } from '../../utils/copyWithFeedback';

type Props = {
  txid: string;
  txHeight: number;
  // `null` only when the selected explorer template cannot produce a URL.
  explorerUrl: string | null;
  walletAddresses: Set<string>;
  onClose: () => void;
};

const SATS_PER_BCH = 100_000_000;

function formatSats(
  amountSats: number | undefined,
  locale: SupportedLocale,
  unknown: string
): string {
  if (amountSats == null || !Number.isFinite(amountSats)) return unknown;
  return `${formatNumber(amountSats / SATS_PER_BCH, locale, {
    maximumFractionDigits: 8,
  })} BCH`;
}

function formatTimestamp(
  locale: SupportedLocale,
  timestamp: string | undefined,
  unavailable: string
): string {
  if (!timestamp) return unavailable;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return unavailable;
  return formatDate(date, locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
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
  const { locale, t } = useI18n();
  return (
    <section className="wallet-card p-4">
      <div className="flex items-center justify-between gap-2 mb-3">
        <h3 className="text-sm font-semibold wallet-text-strong">{title}</h3>
        <span className="text-xs wallet-muted">{rows.length}</span>
      </div>

      <div className="space-y-3">
        {rows.length === 0 ? (
          <div className="text-sm wallet-muted">{t('history.noData')}</div>
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
                      {t('history.output')} #{row.outputIndex}
                    </div>
                  ) : null}
                </div>
                {row.isWalletAddress ? (
                  <StatusChip tone="neutral">
                    {t('history.yourWallet')}
                  </StatusChip>
                ) : null}
              </div>
              <div className="text-sm mt-2 wallet-text-strong">
                {formatSats(row.amountSats, locale, t('history.unknown'))}
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
  const { locale, t } = useI18n();
  const walletId = useSelector(selectWalletId);
  const dispatch = useDispatch();
  const [details, setDetails] = useState<TransactionDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retryCount, setRetryCount] = useState(0);

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
          if (!next) setError(t('history.detailsUnavailable'));
          // Write confirmed height back so Home/list stop showing Unconfirmed
          // for fusion rows that were inserted with height 0 at broadcast.
          // Verbose Electrum often has confs without height — derive via tip.
          if (next && walletId > 0 && isTxConfirmed(next)) {
            const { resolveConfirmedBlockHeight } = await import(
              '../../services/historyHeightBackfill'
            );
            const height = await resolveConfirmedBlockHeight(next);
            if (height != null && height > 0) {
              dispatch(
                addTransactions({
                  wallet_id: walletId,
                  transactions: [
                    {
                      tx_hash: txid,
                      height,
                      timestamp: next.timestamp,
                    },
                  ],
                })
              );
              void TransactionManager()
                .applyConfirmedHeight(walletId, txid, height, next.timestamp)
                .catch(() => undefined);
            }
          }
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : t('history.loadDetailsFailed')
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
  }, [txid, walletId, dispatch, t, retryCount]);

  const markedInputs = useMemo(
    () => markWalletParticipants(details?.inputs ?? [], walletAddresses),
    [details?.inputs, walletAddresses]
  );
  const markedOutputs = useMemo(
    () => markWalletParticipants(details?.outputs ?? [], walletAddresses),
    [details?.outputs, walletAddresses]
  );

  return (
    <Popup closePopups={onClose} closeButtonText={t('history.closeDetails')}>
      <div className="space-y-4 p-1">
        <div>
          <div className="text-xs wallet-muted mb-1">
            {t('history.transaction')}
          </div>
          <button
            type="button"
            className="block w-full text-left font-mono text-sm break-all wallet-text-strong underline decoration-[var(--wallet-border)] underline-offset-4 hover:decoration-current"
            aria-label={t('history.copyTransaction')}
            onClick={() =>
              void copyWithFeedback(txid, 'history.transactionCopied')
            }
          >
            {txid}
          </button>
        </div>

        <section className="wallet-card p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-xs wallet-muted mb-1">
                {t('history.status')}
              </div>
              <div className="text-sm wallet-text-strong">
                {loading
                  ? t('history.loadingDetails')
                  : isTxConfirmed({
                        confirmations: details?.confirmations,
                        height: details?.height ?? txHeight,
                      })
                    ? `${details?.confirmations ?? 1} confirmation${
                        (details?.confirmations ?? 1) === 1 ? '' : 's'
                      }`
                    : t('history.unconfirmed')}
              </div>
            </div>
            {loading ? (
              <StatusChip tone="neutral">
                {t('history.loadingDetails')}
              </StatusChip>
            ) : isTxConfirmed({
                confirmations: details?.confirmations,
                height: details?.height ?? txHeight,
              }) ? (
              <StatusChip tone="success">{t('history.confirmed')}</StatusChip>
            ) : (
              <StatusChip tone="warning">{t('history.unconfirmed')}</StatusChip>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3 mt-4 text-sm">
            <div>
              <div className="text-xs wallet-muted">{t('history.block')}</div>
              <div className="wallet-text-strong">
                {loading
                  ? '…'
                  : details?.height ??
                    (txHeight > 0 ? txHeight : t('history.unconfirmed'))}
              </div>
            </div>
            <div>
              <div className="text-xs wallet-muted">{t('history.fee')}</div>
              <div className="wallet-text-strong">
                {loading
                  ? '…'
                  : formatSats(details?.feeSats, locale, t('history.unknown'))}
              </div>
            </div>
            <div className="col-span-2">
              <div className="text-xs wallet-muted">
                {t('history.timestamp')}
              </div>
              <div className="wallet-text-strong">
                {loading
                  ? '…'
                  : formatTimestamp(
                      locale,
                      details?.timestamp,
                      t('history.unavailable')
                    )}
              </div>
            </div>
            <div className="col-span-2">
              {explorerUrl ? (
                <a
                  href={explorerUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm underline wallet-text-strong"
                >
                  {t('history.openExplorer')}
                </a>
              ) : null}
            </div>
          </div>
        </section>

        {loading ? (
          <div className="wallet-card p-4 text-sm wallet-muted">
            {t('history.loadingDetails')}
          </div>
        ) : error ? (
          <div className="wallet-card p-4" role="alert">
            <p className="text-sm wallet-danger-text">{error}</p>
            <button
              type="button"
              className="wallet-btn-secondary mt-3 min-h-[44px] px-4 py-2 text-sm"
              onClick={() => setRetryCount((count) => count + 1)}
            >
              {t('builder.tryAgain')}
            </button>
          </div>
        ) : (
          <>
            <Section title={t('history.senders')} rows={markedInputs} />
            <Section title={t('history.recipients')} rows={markedOutputs} />
          </>
        )}
      </div>
    </Popup>
  );
}
