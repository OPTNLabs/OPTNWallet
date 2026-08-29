import { useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import PageHeader from '../components/ui/PageHeader';
import { selectWalletId } from '../state/slices/walletSlice';
import useOutboundTransactions from '../hooks/useOutboundTransactions';
import EmptyState from '../components/ui/EmptyState';
import {
  OUTBOUND_RELEASE_DELAY_MS,
  isFusionVerificationPending,
} from '../services/OutboundTransactionTracker';
import WalletScreen from '../components/ui/WalletScreen';
import { useI18n } from '../i18n/useI18n';
import type { TranslationKey } from '../i18n/resources';
import { copyToClipboard } from '../utils/clipboard';

type Translate = (
  key: TranslationKey,
  values?: Record<string, string | number>
) => string;

function relativeAge(
  timestamp: string | null | undefined,
  t: Translate
): string {
  if (!timestamp) return t('outbox.justNow');
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) return t('outbox.justNow');
  const diffMs = Date.now() - parsed;
  const mins = Math.max(0, Math.floor(diffMs / 60000));
  if (mins < 1) return t('outbox.justNow');
  if (mins < 60) return t('outbox.minutesAgo', { count: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t('outbox.hoursAgo', { count: hours });
  return t('outbox.daysAgo', { count: Math.floor(hours / 24) });
}

export default function Outbox() {
  const navigate = useNavigate();
  const { t } = useI18n();
  const walletId = useSelector(selectWalletId);
  const { outboundTransactions, canClear, reconciling, refresh, release } =
    useOutboundTransactions(walletId);

  return (
    <WalletScreen maxWidthClassName="max-w-md" className="pt-4">
      <PageHeader title={t('outbox.title')} compact />

      <div className="wallet-card p-4 mt-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="font-semibold wallet-text-strong">
              {t('outbox.pendingOutgoing')}
            </div>
            <div className="text-sm wallet-muted mt-1">
              {t('outbox.description')}
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
            {reconciling ? t('home.syncing') : t('home.sync')}
          </button>
        </div>
      </div>

      <div className="mt-3">
        {outboundTransactions.length === 0 ? (
          <EmptyState message={t('outbox.noPending')} />
        ) : (
          <div className="space-y-3">
            {outboundTransactions.map((record) => (
              <div key={record.txid} className="wallet-card p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-semibold wallet-text-strong">
                      {record.sourceLabel || t('outbox.walletSend')}
                    </div>
                    <div className="text-xs wallet-muted mt-1">
                      {t('outbox.updated', {
                        age: relativeAge(record.updatedAt, t),
                      })}
                    </div>
                  </div>
                  <div className="text-xs wallet-muted capitalize">
                    {isFusionVerificationPending(record)
                      ? 'Fusion verification pending'
                      : record.state.replaceAll('_', ' ')}
                  </div>
                </div>

                <div className="mt-3 space-y-2 text-sm">
                  <div>
                    <div className="text-xs wallet-muted">
                      {t('outbox.txid')}
                    </div>
                    <div className="font-mono wallet-text-strong break-all">
                      {record.txid}
                    </div>
                  </div>

                  {record.recipientSummary && (
                    <div>
                      <div className="text-xs wallet-muted">
                        {t('outbox.destination')}
                      </div>
                      <div className="wallet-text-strong">
                        {record.recipientSummary}
                      </div>
                    </div>
                  )}

                  {record.amountSummary && (
                    <div>
                      <div className="text-xs wallet-muted">
                        {t('outbox.amount')}
                      </div>
                      <div className="wallet-text-strong">
                        {record.amountSummary}
                      </div>
                    </div>
                  )}

                  {record.dappName && (
                    <div>
                      <div className="text-xs wallet-muted">
                        {t('outbox.requestedBy')}
                      </div>
                      <div className="wallet-text-strong">
                        {record.dappName}
                        {record.dappUrl ? ` (${record.dappUrl})` : ''}
                      </div>
                    </div>
                  )}

                  {record.userPrompt && (
                    <div>
                      <div className="text-xs wallet-muted">
                        {t('outbox.prompt')}
                      </div>
                      <div className="wallet-text-strong">
                        {record.userPrompt}
                      </div>
                    </div>
                  )}

                  {(record.verificationMessage || record.lastError) && (
                    <div>
                      <div className="text-xs wallet-muted">
                        {isFusionVerificationPending(record)
                          ? 'Verification status'
                          : t('outbox.lastNetworkIssue')}
                      </div>
                      <div className="wallet-text-strong">
                        {record.verificationMessage || record.lastError}
                      </div>
                    </div>
                  )}
                </div>

                <div className="mt-4 flex items-center justify-between gap-3">
                  <button
                    type="button"
                    onClick={() => void copyToClipboard(record.txid)}
                    className="wallet-btn-secondary px-3 py-2 text-sm"
                  >
                    {t('outbox.copyTxid')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      void release(record.txid);
                    }}
                    disabled={!canClear(record.txid)}
                    className="wallet-btn-secondary px-3 py-2 text-sm"
                    title={
                      isFusionVerificationPending(record)
                        ? 'Wallet sync must verify this Fusion transaction before its inputs can be reused'
                        : record.state === 'submitted'
                          ? t('outbox.clearPendingTitle')
                          : t('outbox.releaseStaleTitle', {
                              minutes: Math.round(
                                OUTBOUND_RELEASE_DELAY_MS / 60000
                              ),
                            })
                    }
                  >
                    {isFusionVerificationPending(record)
                      ? 'Awaiting verification'
                      : record.state === 'submitted'
                        ? t('outbox.clearPending')
                        : t('outbox.releaseStale')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="fixed bottom-[calc(var(--navbar-height)+var(--safe-bottom)+0.75rem)] left-1/2 z-40 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 px-4">
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="wallet-btn-danger w-full py-3 text-base font-semibold shadow-xl"
        >
          {t('send.back')}
        </button>
      </div>
    </WalletScreen>
  );
}
