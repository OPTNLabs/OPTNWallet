// inside src/components/walletconnect/SignTransactionModal.tsx

import { useRef, useState } from 'react';
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
import { FiChevronDown, FiChevronUp } from 'react-icons/fi';
import { normalizeExternalUrl } from '../../utils/externalUrl';
import { toErrorMessage } from '../../utils/errorHandling';
import { useI18n } from '../../i18n/useI18n';
import ConnectorWalletEffectSummary from '../connect/ConnectorWalletEffectSummary';

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
  const walletId = useSelector(selectWalletId);
  const network = useSelector(selectCurrentNetwork);
  const signTxRequest = useSelector(
    (state: RootState) => state.walletconnect.pendingSignTx
  );
  const activeSessions = useSelector(
    (state: RootState) => state.walletconnect.activeSessions
  );
  const { hasUnresolved } = useOutboundTransactions(walletId);

  const [inputsExpanded, setInputsExpanded] = useState(false);
  const [outputsExpanded, setOutputsExpanded] = useState(true);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  if (!signTxRequest) return null;

  const { topic, params } = signTxRequest;
  const { request } = params;
  const tx = request.params?.transaction;
  const sourceOutputs = request.params?.sourceOutputs ?? [];
  const userPrompt = request.params?.userPrompt ?? '';
  const shouldBroadcast = !!request.params?.broadcast;
  const dappMetadata = activeSessions?.[topic]?.peer?.metadata;
  let preview: ReturnType<typeof transactionPreview> | null = null;
  try {
    preview = transactionPreview(tx, sourceOutputs);
  } catch {
    // Keep malformed requests visible so the user can reject them.
  }
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
    <div className="wallet-popup-backdrop">
      <div className="wallet-popup-panel max-w-2xl w-full flex flex-col space-y-4">
        <h3 className="text-xl font-bold text-center">
          {t('wc.signTransactionRequest')}
        </h3>

        <div className="overflow-y-auto max-h-[60vh] space-y-4 pr-1">
          {dappMetadata && (
            <div className="text-sm wallet-muted">
              <div>
                <strong>{t('wc.dappName')}:</strong> {dappMetadata.name}
              </div>
              <div>
                <strong>{t('wc.domain')}:</strong>{' '}
                {dappUrl ? (
                  <a
                    href={dappUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="wallet-link underline"
                  >
                    {dappMetadata.url}
                  </a>
                ) : (
                  <span className="wallet-muted break-all">
                    {dappMetadata.url}
                  </span>
                )}
              </div>
            </div>
          )}

          {userPrompt && (
            <p className="text-sm wallet-surface-strong border border-[var(--wallet-border)] rounded p-2 wallet-text-strong">
              <strong>{t('wc.prompt')}:</strong> {userPrompt}
            </p>
          )}

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
            <div className="wallet-surface-strong border border-[var(--wallet-border)] rounded p-3 text-sm space-y-2">
              <div className="font-semibold">
                {network === 'chipnet' ? 'Chipnet' : 'Mainnet'} transaction
              </div>
              <p>
                {shouldBroadcast
                  ? 'The wallet will sign and attempt to broadcast. The app also receives the signed transaction.'
                  : 'The wallet will sign and return the transaction to the app. The app may broadcast it later.'}
              </p>
              <p className="wallet-muted">
                Amounts below describe the whole transaction, including other
                participants. The verified wallet effect is calculated
                separately from outputs matching this wallet.
              </p>
            </div>
          )}

          {preview && (
            <ConnectorWalletEffectSummary
              preview={preview}
              walletId={walletId}
            />
          )}

          <div className="space-y-2">
            <button
              type="button"
              onClick={() => setInputsExpanded(!inputsExpanded)}
              className="flex items-center gap-2 text-sm font-semibold wallet-text-strong"
            >
              {inputsExpanded ? <FiChevronUp /> : <FiChevronDown />}
              {t('wc.inputs', { count: inputs.length })}
            </button>
            {inputsExpanded && (
              <div className="space-y-1">
                {inputs.map((source, i: number) => {
                  const txid = binToHex(source.outpointTransactionHash);
                  const value = source.valueSatoshis;
                  return (
                    <div key={i} className="ml-2">
                      <div>
                        {t('wc.txid')}:{' '}
                        <span className="font-mono break-all">{txid}</span>
                      </div>
                      <div>
                        {t('wc.index')}: {source.outpointIndex}
                      </div>
                      <div>{Number(value) / SATSINBITCOIN} BCH</div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="space-y-2">
            <button
              type="button"
              onClick={() => setOutputsExpanded(!outputsExpanded)}
              className="flex items-center gap-2 text-sm font-semibold wallet-text-strong"
            >
              {outputsExpanded ? <FiChevronUp /> : <FiChevronDown />}
              {t('wc.outputs', { count: outputs.length })}
            </button>
            {outputsExpanded && (
              <div className="space-y-1">
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
                        className="ml-2 space-y-1 border-b border-[var(--wallet-border)] pb-2 text-sm"
                      >
                        <strong>{t('wc.opReturnOutput')}</strong>
                        {parsed.map((data, j) => (
                          <div
                            key={j}
                            className="font-mono wallet-muted break-words"
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
                      className="ml-2 border-b border-[var(--wallet-border)] pb-2 space-y-1"
                    >
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
            )}
          </div>

          {preview && (
            <div className="text-sm border-t border-[var(--wallet-border)] pt-2">
              <div>
                {t('wc.totalInput')}:{' '}
                {Number(preview.totalInput) / SATSINBITCOIN} BCH
              </div>
              <div>
                {t('wc.totalOutput')}:{' '}
                {Number(preview.totalOutput) / SATSINBITCOIN} BCH
              </div>
              <div className="font-semibold">
                {t('wc.estimatedFee')}: {Number(preview.fee) / SATSINBITCOIN}{' '}
                BCH
              </div>
              <div>
                Wallet broadcast requested:{' '}
                {shouldBroadcast ? t('wc.yes') : t('wc.no')}
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-around pt-2">
          <button
            onClick={handleSign}
            className="wallet-btn-primary"
            disabled={broadcastLocked || !preview || busy}
            title={broadcastLocked ? t('wc.waitPrevious') : undefined}
          >
            {broadcastLocked && shouldBroadcast
              ? t('wc.waitingForSync')
              : busy
                ? t('wc.working')
                : t('wc.sign')}
          </button>
          <button
            onClick={handleCancel}
            className="wallet-btn-danger"
            disabled={busy}
          >
            {t('wc.cancel')}
          </button>
        </div>
      </div>
    </div>
  );
}
