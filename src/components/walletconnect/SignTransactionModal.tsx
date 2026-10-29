// inside src/components/walletconnect/SignTransactionModal.tsx

import { useId, useMemo, useRef, useState } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { RootState, AppDispatch } from '../../state/store';
import {
  respondWithTxSignature,
  clearPendingSignTx,
  respondWithTxError,
  syncWalletConnectSessions,
} from '../../state/slices/walletconnectSlice';
import { enqueueNotification } from '../../state/slices/notificationsSlice';
import { binToHex, lockingBytecodeToCashAddress } from '@bitauth/libauth';
import { PREFIX, SATSINBITCOIN } from '../../utils/constants';
import { transactionPreview } from '../../services/connect/transactionPreview';
import { selectCurrentNetwork } from '../../state/selectors/networkSelectors';
import { selectWalletId } from '../../state/slices/walletSlice';
import useOutboundTransactions from '../../hooks/useOutboundTransactions';
import { shortenAddress } from '../../utils/shortenHash';
import WalletTooltip from '../ui/WalletTooltip';
import { normalizeExternalUrl } from '../../utils/externalUrl';
import { toErrorMessage } from '../../utils/errorHandling';
import { useI18n } from '../../i18n/useI18n';
import ConnectorWalletEffectSummary from '../connect/ConnectorWalletEffectSummary';
import ConnectorTransactionSummary from '../connect/ConnectorTransactionSummary';
import { describeConnectorRequest } from '../../services/connect/requestDescription';
import WalletPopupSheet from '../ui/WalletPopupSheet';

function isStaleWalletConnectError(error: unknown): boolean {
  const message = toErrorMessage(error).toLowerCase();
  return (
    message.includes('session') &&
    (message.includes('missing') ||
      message.includes('deleted') ||
      message.includes('expired') ||
      message.includes('disconnected') ||
      message.includes('not found'))
  );
}

export function SignTransactionModal() {
  const dispatch = useDispatch<AppDispatch>();
  const { t } = useI18n();
  const titleId = useId();
  const walletId = useSelector(selectWalletId);
  const network = useSelector(selectCurrentNetwork);
  const signTxRequest = useSelector(
    (state: RootState) => state.walletconnect.pendingSignTx
  );
  const activeSessions = useSelector(
    (state: RootState) => state.walletconnect.activeSessions
  );
  const { hasUnresolved } = useOutboundTransactions(walletId);

  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  const tx = signTxRequest?.params?.request?.params?.transaction;
  const rawSourceOutputs =
    signTxRequest?.params?.request?.params?.sourceOutputs;
  const preview = useMemo(() => {
    if (!tx) return null;
    try {
      return transactionPreview(tx, rawSourceOutputs ?? []);
    } catch {
      // Keep malformed requests visible so the user can reject them.
      return null;
    }
  }, [rawSourceOutputs, tx]);

  if (!signTxRequest) return null;

  const { topic, params } = signTxRequest;
  const { request } = params;
  const userPrompt = request.params?.userPrompt ?? '';
  const requestDescription = describeConnectorRequest(userPrompt);
  const shouldBroadcast = !!request.params?.broadcast;
  const dappMetadata = activeSessions?.[topic]?.peer?.metadata;
  const inputs = preview?.inputs ?? [];
  const outputs = preview?.outputs ?? [];

  function parsePushData(bytecode: Uint8Array): string[] {
    const result: string[] = [];
    let i = 1; // skip OP_RETURN
    while (i < bytecode.length) {
      const len = bytecode[i];
      i += 1;
      const chunk = bytecode.slice(i, i + len);
      const hex = binToHex(chunk);
      const ascii = new TextDecoder('utf-8', { fatal: false }).decode(chunk);
      result.push(`${ascii} (0x${hex})`);
      i += len;
    }
    return result;
  }

  function toCashAddress(bytecode: Uint8Array): string {
    try {
      const result = lockingBytecodeToCashAddress({
        prefix: PREFIX[network],
        bytecode,
      });
      return typeof result === 'string' ? `⚠️ ${result}` : result.address;
    } catch {
      return `⚠️ ${t('wc.invalidLockingBytecode')}`;
    }
  }

  const broadcastLocked = shouldBroadcast && hasUnresolved;
  const dappUrl = dappMetadata?.url
    ? normalizeExternalUrl(dappMetadata.url)
    : null;

  const handleSign = async () => {
    if (broadcastLocked || !preview || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const outcome = await dispatch(
        respondWithTxSignature(signTxRequest)
      ).unwrap();
      const outcomeMessage =
        outcome.kind === 'broadcasted'
          ? 'Signed and broadcast by this wallet.'
          : outcome.kind === 'submitted'
            ? 'Signed and submitted. Watch transaction history before sending again.'
            : outcome.kind === 'failed'
              ? `Signed transaction returned to the app, but wallet broadcast failed: ${outcome.message}. The app may still submit it.`
              : outcome.kind === 'not_attempted_hardware'
                ? 'Signed on the hardware wallet and returned to the app. Wallet broadcast was not attempted; the app may submit it.'
                : 'Signed transaction returned to the app. The app may submit it later.';
      dispatch(
        enqueueNotification({
          id: `walletconnect:tx:signed:${topic}:${signTxRequest.id}`,
          kind: 'walletconnect',
          title: t('wc.transactionApprovedTitle'),
          body: outcomeMessage,
          createdAt: Date.now(),
        })
      );
      dispatch(clearPendingSignTx());
    } catch (error) {
      console.error(
        '[WalletConnect] Failed to sign transaction request',
        error
      );
      if (isStaleWalletConnectError(error)) {
        void dispatch(syncWalletConnectSessions());
        dispatch(clearPendingSignTx());
        dispatch(
          enqueueNotification({
            id: `walletconnect:tx:stale:${topic}:${signTxRequest.id}`,
            kind: 'walletconnect',
            title: t('wc.sessionDisconnectedTitle'),
            body: t('wc.transactionStaleBody'),
            createdAt: Date.now(),
          })
        );
        return;
      }
      dispatch(
        enqueueNotification({
          id: `walletconnect:tx:sign-error:${topic}:${signTxRequest.id}`,
          kind: 'walletconnect',
          title: t('wc.transactionFailedTitle'),
          body: t('wc.transactionFailedBody', {
            message: toErrorMessage(error),
          }),
          createdAt: Date.now(),
        })
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const handleCancel = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      await dispatch(respondWithTxError(signTxRequest)).unwrap();
      dispatch(
        enqueueNotification({
          id: `walletconnect:tx:rejected:${topic}:${signTxRequest.id}`,
          kind: 'walletconnect',
          title: t('wc.transactionRejectedTitle'),
          body: t('wc.rejectionSentBody'),
          createdAt: Date.now(),
        })
      );
      dispatch(clearPendingSignTx());
    } catch (error) {
      console.error(
        '[WalletConnect] Failed to reject transaction request',
        error
      );
      if (isStaleWalletConnectError(error)) {
        void dispatch(syncWalletConnectSessions());
        dispatch(clearPendingSignTx());
        dispatch(
          enqueueNotification({
            id: `walletconnect:tx:reject-stale:${topic}:${signTxRequest.id}`,
            kind: 'walletconnect',
            title: t('wc.sessionDisconnectedTitle'),
            body: t('wc.rejectionStaleBody'),
            createdAt: Date.now(),
          })
        );
        return;
      }
      dispatch(
        enqueueNotification({
          id: `walletconnect:tx:reject-error:${topic}:${signTxRequest.id}`,
          kind: 'walletconnect',
          title: t('wc.rejectionFailedTitle'),
          body: t('wc.transactionRejectionFailedBody', {
            message: toErrorMessage(error),
          }),
          createdAt: Date.now(),
        })
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <WalletPopupSheet
      maxWidthClassName="max-w-2xl"
      onDismiss={busy ? undefined : handleCancel}
      dismissLabel={t('wc.rejectRequest')}
      showDismissButton={false}
      ariaLabelledBy={titleId}
      footer={
        <div className="grid grid-cols-2 gap-3 pb-[var(--safe-bottom)]">
          <button
            type="button"
            onClick={handleCancel}
            className="wallet-btn-danger min-h-[48px] w-full"
            disabled={busy}
          >
            {t('wc.rejectRequest')}
          </button>
          <button
            type="button"
            onClick={handleSign}
            className="wallet-btn-primary min-h-[48px] w-full"
            disabled={broadcastLocked || !preview || busy}
            title={broadcastLocked ? t('wc.waitPrevious') : undefined}
          >
            {broadcastLocked && shouldBroadcast
              ? t('wc.waitingForSync')
              : busy
                ? t('wc.working')
                : shouldBroadcast
                  ? t('txReview.signAndBroadcast')
                  : t('txReview.signAndReturn')}
          </button>
        </div>
      }
    >
      <div className="-mx-6 -mt-6">
        <header className="sticky top-0 z-10 border-b border-[var(--wallet-border)] bg-[var(--wallet-card-bg)] px-6 pb-4 pt-5">
          <h3
            id={titleId}
            className="text-xl font-bold text-center wallet-text-strong"
          >
            {t(requestDescription.titleKey)}
          </h3>
          <p className="mt-1 text-center text-sm wallet-muted">
            {t('txReview.reviewBeforeSigning')}
          </p>
          {(requestDescription.detail || dappMetadata) && (
            <div className="mt-3 rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-card-bg)] px-3 py-2 text-sm">
              {dappMetadata && (
                <div className="font-semibold wallet-text-strong">
                  {dappMetadata.name || t('wc.unknownDapp')}
                </div>
              )}
              {dappMetadata?.url && (
                <div className="mt-1 text-xs wallet-muted">
                  <span>{t('txReview.requestedBy')} </span>
                  {dappUrl ? (
                    <a
                      href={dappUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="wallet-link break-all underline"
                    >
                      {dappMetadata.url}
                    </a>
                  ) : (
                    <span className="break-all">{dappMetadata.url}</span>
                  )}
                </div>
              )}
              {requestDescription.detail && (
                <div className="mt-2 text-xs wallet-muted">
                  <span className="font-semibold">
                    {t('txReview.appDescription')}:
                  </span>{' '}
                  {requestDescription.detail}
                </div>
              )}
            </div>
          )}
        </header>

        <div className="space-y-4 px-6 py-4">
          {broadcastLocked && (
            <div className="text-sm wallet-surface-strong border border-[var(--wallet-border)] rounded p-3 wallet-text-strong">
              {t('wc.broadcastLocked')}
            </div>
          )}

          {!preview && (
            <div
              role="alert"
              className="text-sm wallet-surface-strong border border-[var(--wallet-border)] rounded p-3 wallet-text-strong"
            >
              {t('wc.unsupportedTransaction')}
            </div>
          )}

          {preview && (
            <ConnectorWalletEffectSummary
              preview={preview}
              walletId={walletId}
              tokenLabel={requestDescription.tokenLabel}
            />
          )}

          {preview && (
            <ConnectorTransactionSummary
              network={network}
              operation={
                shouldBroadcast ? 'sign-and-broadcast' : 'sign-and-return'
              }
              preview={preview}
            />
          )}

          <details className="rounded-xl border border-[var(--wallet-border)] px-3 py-2">
            <summary className="cursor-pointer font-semibold wallet-text-strong">
              {t('txReview.technicalDetails')}{' '}
              <span className="font-normal wallet-muted">
                ({inputs.length} inputs · {outputs.length} outputs)
              </span>
            </summary>
            <div className="mt-3 space-y-4">
              <section aria-labelledby="walletconnect-inputs-title">
                <h4
                  id="walletconnect-inputs-title"
                  className="text-sm font-semibold wallet-text-strong"
                >
                  {t('wc.inputs', { count: inputs.length })}
                </h4>
                <div className="mt-2 space-y-2">
                  {inputs.map((source, i: number) => {
                    const txid = binToHex(source.outpointTransactionHash);
                    const value = source.valueSatoshis;
                    return (
                      <div
                        key={i}
                        className="rounded-xl border border-[var(--wallet-border)] p-3 text-sm"
                      >
                        <div className="font-semibold wallet-text-strong">
                          {t('wc.inputNumber', { number: i + 1 })}
                        </div>
                        <div className="mt-1">
                          {t('wc.previousTransaction')}:{' '}
                          <span className="font-mono break-all">{txid}</span>
                        </div>
                        <div>
                          {t('wc.outputIndex')}: {source.outpointIndex}
                        </div>
                        <div>{Number(value) / SATSINBITCOIN} BCH</div>
                      </div>
                    );
                  })}
                </div>
              </section>

              <section aria-labelledby="walletconnect-outputs-title">
                <h4
                  id="walletconnect-outputs-title"
                  className="text-sm font-semibold wallet-text-strong"
                >
                  {t('wc.outputs', { count: outputs.length })}
                </h4>
                <div className="mt-2 space-y-2">
                  {outputs.map((output, i: number) => {
                    const value = output.valueSatoshis;
                    const lockingBytecode = output.lockingBytecode;
                    const isOpReturn = lockingBytecode[0] === 0x6a;
                    const token = output.token;

                    if (isOpReturn) {
                      const parsed = parsePushData(lockingBytecode);
                      return (
                        <div
                          key={i}
                          className="rounded-xl border border-[var(--wallet-border)] p-3 text-sm"
                        >
                          <strong>{t('wc.opReturnOutput')}</strong>
                          {parsed.map((data, j) => (
                            <div
                              key={j}
                              className="mt-1 font-mono wallet-muted break-words"
                            >
                              {data}
                            </div>
                          ))}
                        </div>
                      );
                    }

                    const address = toCashAddress(lockingBytecode);
                    return (
                      <div
                        key={i}
                        className="rounded-xl border border-[var(--wallet-border)] p-3 text-sm space-y-1"
                      >
                        <div className="font-semibold wallet-text-strong">
                          {t('wc.outputNumber', { number: i + 1 })}
                        </div>
                        <div>
                          {t('wc.address')}:{' '}
                          <span
                            className="font-mono wallet-link break-all cursor-pointer"
                            data-tooltip-id={`address-tooltip-${i}`}
                            data-tooltip-content={address}
                          >
                            {shortenAddress(address)}
                          </span>
                          <WalletTooltip
                            id={`address-tooltip-${i}`}
                            place="top"
                            clickable={true}
                            content={address}
                          />
                        </div>
                        <div>{Number(value) / SATSINBITCOIN} BCH</div>
                        {token && (
                          <div className="text-sm wallet-surface-strong border border-[var(--wallet-border)] rounded p-2 space-y-1">
                            <div>
                              <strong>{t('wc.tokenCategory')}:</strong>{' '}
                              <span className="font-mono break-all">
                                {binToHex(token.category)}
                              </span>
                            </div>
                            {token.amount !== undefined &&
                              token.amount !== null && (
                                <div>
                                  <strong>{t('wc.fungibleAmount')}:</strong>{' '}
                                  {String(token.amount)}
                                </div>
                              )}
                            {token.nft && (
                              <>
                                <div>
                                  <strong>{t('wc.nftCapability')}:</strong>{' '}
                                  {token.nft.capability}
                                </div>
                                {token.nft.commitment && (
                                  <div>
                                    <strong>{t('wc.nftCommitment')}:</strong>{' '}
                                    <span className="font-mono break-all">
                                      {binToHex(token.nft.commitment)}
                                    </span>
                                  </div>
                                )}
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            </div>
          </details>
        </div>
      </div>
    </WalletPopupSheet>
  );
}
