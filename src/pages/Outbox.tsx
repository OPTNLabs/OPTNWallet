import { useState } from 'react';
import { useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import PageHeader from '../components/ui/PageHeader';
import { selectWalletId } from '../state/slices/walletSlice';
import { selectCurrentNetwork } from '../state/selectors/networkSelectors';
import { Network } from '../state/slices/networkSlice';
import useOutboundTransactions from '../hooks/useOutboundTransactions';
import EmptyState from '../components/ui/EmptyState';
import {
  OUTBOUND_RELEASE_DELAY_MS,
  isFusionVerificationPending,
} from '../services/OutboundTransactionTracker';
import WalletScreen from '../components/ui/WalletScreen';
import { useI18n } from '../i18n/useI18n';
import type { TranslationKey } from '../i18n/resources';
import { copyWithFeedback } from '../utils/copyWithFeedback';
import NetworkContextBanner from '../components/ui/NetworkContextBanner';
import MaskedValue from '../components/ui/MaskedValue';
import InfoButton from '../components/ui/InfoButton';
import { useWalletConfirm } from '../components/WalletConfirmDialog';
import type { OutboundTransactionState } from '../services/OutboundTransactionTracker';

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

function stateLabel(state: OutboundTransactionState, t: Translate): string {
  switch (state) {
    case 'broadcasting':
      return t('outbox.stateBroadcasting');
    case 'submitted':
      return t('outbox.stateSubmitted');
    case 'broadcasted':
      return t('outbox.stateBroadcasted');
    case 'seen':
      return t('outbox.stateSeen');
  }
}

function stateHelp(state: OutboundTransactionState, t: Translate): string {
  switch (state) {
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

function isAddressLikeSummary(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return [
    'bitcoincash:',
    'bchtest:',
    'simpleledger:',
    'slptest:',
    'cashcode:',
    'cashcodetest:',
    'paycode:',
    'paycodetest:',
  ].some((prefix) => normalized.startsWith(prefix));
}

function friendlyNetworkIssue(message: string, t: Translate): string {
  const normalized = message.toLowerCase();
  if (normalized.includes('insufficient funds')) {
    return t('send.insufficientFunds');
  }
  if (
    /\b(connection|timeout|econnrefused|offline|unreachable)\b/i.test(
      message
    ) ||
    /^network error\b/i.test(message)
  ) {
    return t('send.networkError');
  }
  return t('send.genericError');
}

export default function Outbox() {
  const navigate = useNavigate();
  const { t } = useI18n();
  const walletId = useSelector(selectWalletId);
  const currentNetwork = useSelector(selectCurrentNetwork);
  const confirm = useWalletConfirm();
  const [confirmingReleaseTxid, setConfirmingReleaseTxid] = useState<
    string | null
  >(null);
  const { outboundTransactions, canClear, reconciling, refresh, release } =
    useOutboundTransactions(walletId);

  const handleRelease = async (
    record: (typeof outboundTransactions)[number]
  ) => {
    if (confirmingReleaseTxid === record.txid) return;
    setConfirmingReleaseTxid(record.txid);
    const message =
      record.state === 'submitted'
        ? t('outbox.clearPendingTitle')
        : t('outbox.releaseStaleTitle', {
            minutes: Math.round(OUTBOUND_RELEASE_DELAY_MS / 60000),
          });
    try {
      if (!(await confirm(message))) return;
      await release(record.txid);
    } finally {
      setConfirmingReleaseTxid(null);
    }
  };

  return (
    <WalletScreen
      maxWidthClassName="max-w-md"
      className="pt-4"
      reserveBottomNavSpace
    >
      <PageHeader
        title={t('outbox.title')}
        subtitle={
          currentNetwork === Network.CHIPNET ? t('network.chipnet') : undefined
        }
        compact
      />
      <NetworkContextBanner network={currentNetwork} className="mt-3" />

      <div className="wallet-card p-4 mt-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-1 font-semibold wallet-text-strong">
              <span>{t('outbox.pendingOutgoing')}</span>
              <InfoButton
                id="outbox-pending-help"
                ariaLabel={t('outbox.pendingHelpLabel')}
                content={t('outbox.pendingHelp')}
              />
            </div>
            {outboundTransactions.length > 0 ? (
              <div className="text-sm wallet-muted mt-1">
                {t('outbox.description')}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            onClick={() => {
              void refresh();
            }}
            disabled={reconciling}
            className="wallet-btn-secondary min-h-[44px] px-3 py-2 text-sm shrink-0"
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
                  <div className="flex items-center gap-1 text-xs wallet-muted">
                    <span>
                      {isFusionVerificationPending(record)
                        ? t('outbox.fusionVerificationPending')
                        : stateLabel(record.state, t)}
                    </span>
                    <InfoButton
                      id={`outbox-state-${record.txid}`}
                      ariaLabel={t('outbox.stateHelpLabel')}
                      content={
                        isFusionVerificationPending(record)
                          ? t('outbox.verificationWaitDescription')
                          : stateHelp(record.state, t)
                      }
                    />
                  </div>
                </div>

                <div className="mt-3 space-y-2 text-sm">
                  <div>
                    <div className="text-xs wallet-muted">
                      {t('outbox.txid')}
                    </div>
                    <MaskedValue
                      value={record.txid}
                      label={t('history.transactionId')}
                      copySuccessMessageKey="history.transactionCopied"
                      className="block max-w-full break-all wallet-text-strong"
                    />
                  </div>

                  {record.recipientSummary && (
                    <div>
                      <div className="text-xs wallet-muted">
                        {t('outbox.destination')}
                      </div>
                      {isAddressLikeSummary(record.recipientSummary) ? (
                        <MaskedValue
                          value={record.recipientSummary}
                          label={t('outbox.destination')}
                          copySuccessMessageKey="receive.addressCopied"
                          className="block max-w-full break-all wallet-text-strong"
                        />
                      ) : (
                        <div className="wallet-text-strong">
                          {record.recipientSummary}
                        </div>
                      )}
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
                          ? t('outbox.verificationStatus')
                          : t('outbox.lastNetworkIssue')}
                      </div>
                      {record.verificationMessage ? (
                        <div className="wallet-text-strong">
                          {record.verificationMessage}
                        </div>
                      ) : (
                        <>
                          <div className="wallet-text-strong">
                            {friendlyNetworkIssue(record.lastError ?? '', t)}
                          </div>
                          <details className="mt-2 rounded-xl border border-[var(--wallet-border)] px-3 py-2">
                            <summary className="flex min-h-[44px] cursor-pointer items-center text-xs font-semibold wallet-text-strong">
                              {t('send.technicalDetails')}
                            </summary>
                            <p className="mt-2 break-words text-xs font-mono wallet-muted">
                              {record.lastError}
                            </p>
                          </details>
                        </>
                      )}
                    </div>
                  )}
                </div>

                <div className="mt-4 flex items-center justify-between gap-3">
                  <button
                    type="button"
                    onClick={() => void copyWithFeedback(record.txid)}
                    className="wallet-btn-secondary min-h-[44px] px-3 py-2 text-sm"
                  >
                    {t('outbox.copyTxid')}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleRelease(record)}
                    disabled={
                      !canClear(record.txid) ||
                      confirmingReleaseTxid === record.txid
                    }
                    className="wallet-btn-secondary min-h-[44px] px-3 py-2 text-sm"
                    aria-describedby={
                      isFusionVerificationPending(record)
                        ? `outbox-verification-${record.txid}`
                        : undefined
                    }
                    title={
                      isFusionVerificationPending(record)
                        ? t('outbox.verificationWaitDescription')
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
                      ? t('outbox.awaitingVerification')
                      : record.state === 'submitted'
                        ? t('outbox.clearPending')
                        : t('outbox.releaseStale')}
                  </button>
                  <InfoButton
                    id={`outbox-release-${record.txid}`}
                    ariaLabel={t('outbox.releaseHelpLabel')}
                    content={
                      isFusionVerificationPending(record)
                        ? t('outbox.verificationWaitDescription')
                        : record.state === 'submitted'
                          ? t('outbox.clearPendingTitle')
                          : t('outbox.releaseStaleTitle', {
                              minutes: Math.round(
                                OUTBOUND_RELEASE_DELAY_MS / 60000
                              ),
                            })
                    }
                  />
                </div>
                {isFusionVerificationPending(record) && (
                  <p
                    id={`outbox-verification-${record.txid}`}
                    className="mt-2 text-xs wallet-muted"
                  >
                    {t('outbox.verificationWaitDescription')}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mt-4 px-1">
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="wallet-btn-secondary w-full min-h-[44px] py-3 text-base font-semibold"
        >
          {t('send.back')}
        </button>
      </div>
    </WalletScreen>
  );
}
