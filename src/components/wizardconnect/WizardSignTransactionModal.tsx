import { useMemo, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { binToHex, lockingBytecodeToCashAddress } from '@bitauth/libauth';
import type { AppDispatch, RootState } from '../../state/store';
import {
  approveWizardSignRequest,
  rejectWizardSignRequest,
} from '../../state/slices/wizardconnectSlice';
import { previewWizardSignInProof } from '../../services/wizardconnect/signInProofPreview';
import { selectWizardSignInProofsEnabled } from '../../state/slices/preferencesSlice';
import WizardSignInProofView from './WizardSignInProofView';
import { ensureUint8Array, parseSatoshis } from '../../utils/binary';
import { PREFIX, SATSINBITCOIN } from '../../utils/constants';
import { selectCurrentNetwork } from '../../state/selectors/networkSelectors';
import { wizardConnectionStatus } from '../../utils/connectionStatus';
import { toErrorMessage } from '../../utils/errorHandling';
import { useI18n } from '../../i18n/useI18n';
import { decodeWizardConnectTransaction } from '../../services/wizardconnect/transaction';
import { showWalletNotification } from '../../utils/copyWithFeedback';
import { selectWalletId } from '../../state/slices/walletSlice';
import { transactionPreview } from '../../services/connect/transactionPreview';
import { describeConnectorRequest } from '../../services/connect/requestDescription';
import ConnectorWalletEffectSummary from '../connect/ConnectorWalletEffectSummary';
import ConnectorTransactionSummary from '../connect/ConnectorTransactionSummary';
import MaskedConnectorDescription from '../connect/MaskedConnectorDescription';
import MaskedValue from '../ui/MaskedValue';
import NetworkContextBanner from '../ui/NetworkContextBanner';
import InfoButton from '../ui/InfoButton';
import { isUiFixtureEnabled } from '../../ui-fixtures/fixtureData';

type TxAmountCarrier = { valueSatoshis: unknown };
type TxToken = {
  category: unknown;
  amount?: unknown;
  nft?: { capability?: string; commitment?: unknown };
};
type TxOutput = TxAmountCarrier & {
  lockingBytecode: unknown;
  token?: TxToken;
};
type TxInputSource = TxAmountCarrier & { lockingBytecode: unknown };

function parsePushData(bytecode: Uint8Array): string[] {
  const result: string[] = [];
  let i = 1;

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

export default function WizardSignTransactionModal() {
  const dispatch = useDispatch<AppDispatch>();
  const { t } = useI18n();
  const walletId = useSelector(selectWalletId);
  const network = useSelector(selectCurrentNetwork);
  const pending = useSelector(
    (state: RootState) => state.wizardconnect.pendingSignRequest
  );
  const connections = useSelector(
    (state: RootState) => state.wizardconnect.activeConnections
  );
  const signInProofsEnabled = useSelector(selectWizardSignInProofsEnabled);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  const payload = pending?.request.transaction;
  let decoded: ReturnType<typeof decodeWizardConnectTransaction> | null = null;
  if (payload) {
    try {
      decoded = decodeWizardConnectTransaction(payload);
    } catch {
      // A failed preview must never leave an approval button enabled.
    }
  }
  const tx = decoded?.transaction;
  const sourceOutputs = decoded?.sourceOutputs ?? [];
  const connectorPreview = useMemo(() => {
    if (!decoded) return null;
    try {
      return transactionPreview(decoded.transaction, decoded.sourceOutputs);
    } catch {
      return null;
    }
  }, [decoded]);

  if (!pending || !payload) return null;

  const connection = connections[pending.connectionId];
  const signInProof = previewWizardSignInProof(pending.request);
  const requestDescription = describeConnectorRequest(payload.userPrompt);
  const outputs = tx?.outputs ?? [];
  const totalInput = (sourceOutputs as TxInputSource[]).reduce(
    (sum, output) => sum + parseSatoshis(output.valueSatoshis),
    0n
  );
  const totalOutput = (outputs as TxOutput[]).reduce(
    (sum, output) => sum + parseSatoshis(output.valueSatoshis),
    0n
  );
  const canApprove =
    !!tx &&
    tx.inputs.length > 0 &&
    sourceOutputs.length === tx.inputs.length &&
    totalInput >= totalOutput;

  function describeLockingDestination(bytecode: Uint8Array) {
    try {
      const result = lockingBytecodeToCashAddress({
        prefix: PREFIX[network],
        bytecode,
      });
      return typeof result === 'string'
        ? { label: t('wc.lockingScript'), value: `0x${binToHex(bytecode)}` }
        : { label: t('wizard.address'), value: result.address };
    } catch {
      return { label: t('wc.lockingScript'), value: `0x${binToHex(bytecode)}` };
    }
  }

  const handleApprove = async () => {
    if (isUiFixtureEnabled() || !canApprove || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      await dispatch(approveWizardSignRequest()).unwrap();
      await showWalletNotification(t('wizard.signedReturned'));
    } catch (error) {
      console.error(
        '[WizardConnect] Failed to approve transaction request',
        error
      );
      await showWalletNotification(
        t('wizard.approveFailed', { message: toErrorMessage(error) })
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const handleReject = async () => {
    if (isUiFixtureEnabled() || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      await dispatch(rejectWizardSignRequest()).unwrap();
      await showWalletNotification(t('wizard.rejected'));
    } catch (error) {
      console.error(
        '[WizardConnect] Failed to reject transaction request',
        error
      );
      await showWalletNotification(
        t('wizard.rejectFailed', { message: toErrorMessage(error) })
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  if (signInProof.kind !== 'none') {
    const proofApprove = async () => {
      if (
        isUiFixtureEnabled() ||
        signInProof.kind !== 'proof' ||
        !signInProofsEnabled ||
        inFlight.current
      ) {
        return;
      }
      inFlight.current = true;
      setBusy(true);
      try {
        await dispatch(approveWizardSignRequest()).unwrap();
        await showWalletNotification(t('wizard.signedReturned'));
      } catch (error) {
        console.error(
          '[WizardConnect] Failed to sign the sign-in proof',
          error
        );
        await showWalletNotification(
          t('wizard.approveFailed', { message: toErrorMessage(error) })
        );
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    };
    return (
      <WizardSignInProofView
        dappName={
          connection?.dappName ?? connection?.label ?? t('wizard.unknownDapp')
        }
        schemeLabel={
          signInProof.kind === 'proof' ? signInProof.schemeLabel : undefined
        }
        address={signInProof.kind === 'proof' ? signInProof.address : undefined}
        code={signInProof.kind === 'proof' ? signInProof.code : undefined}
        error={signInProof.kind === 'invalid' ? signInProof.message : undefined}
        disabledBySetting={!signInProofsEnabled}
        busy={busy}
        onApprove={() => void proofApprove()}
        onReject={() => void handleReject()}
      />
    );
  }

  return (
    <div className="wallet-popup-backdrop">
      <div className="wallet-popup-panel max-w-2xl w-full flex flex-col space-y-4">
        <h3 className="text-xl font-bold text-center">
          {t('wizard.signRequest')}
        </h3>

        <div className="overflow-y-auto max-h-[60vh] space-y-4 pr-1">
          <div className="text-sm wallet-muted">
            <div>
              <strong>{t('wizard.dapp')}:</strong>{' '}
              {connection?.dappName ??
                connection?.label ??
                t('wizard.unknownDapp')}
            </div>
            <div>
              <strong>{t('wizard.status')}:</strong>{' '}
              {t(
                wizardConnectionStatus(connection?.status.status ?? 'pending')
              )}{' '}
              <InfoButton
                id="wizard-sign-status-help"
                ariaLabel={t('wizard.statusHelpLabel')}
                content={t('wizard.statusHelp')}
              />
            </div>
          </div>

          <NetworkContextBanner network={network} />

          {payload.userPrompt && (
            <p className="text-sm wallet-surface-strong border border-[var(--wallet-border)] rounded p-2 wallet-text-strong">
              <strong>{t('wizard.prompt')}:</strong>{' '}
              <MaskedConnectorDescription value={payload.userPrompt} />
            </p>
          )}

          {!canApprove && (
            <div className="text-sm wallet-surface-strong border border-[var(--wallet-border)] rounded p-3 wallet-text-strong">
              {t('wizard.unsupportedTransaction')}
            </div>
          )}

          {canApprove && connectorPreview && (
            <ConnectorTransactionSummary
              operation="sign-and-return"
              preview={connectorPreview}
            />
          )}

          {canApprove && connectorPreview && (
            <ConnectorWalletEffectSummary
              preview={connectorPreview}
              walletId={walletId}
              tokenLabel={requestDescription.tokenLabel}
            />
          )}

          {tx && canApprove && (
            <>
              <details className="rounded-xl border border-[var(--wallet-border)] px-3 py-2">
                <summary className="flex min-h-[44px] cursor-pointer items-center font-semibold">
                  {t('wizard.technicalDetails', {
                    inputs: sourceOutputs.length,
                    outputs: outputs.length,
                  })}
                </summary>
                <div className="mt-3 space-y-3">
                  {(sourceOutputs as TxInputSource[]).map((source, index) => (
                    <div
                      key={`${pending.request.sequence}-${index}`}
                      className="ml-2"
                    >
                      {(() => {
                        const sourceDestination = describeLockingDestination(
                          ensureUint8Array(source.lockingBytecode)
                        );
                        return (
                          <div>
                            {sourceDestination.label}:{' '}
                            <MaskedValue
                              value={sourceDestination.value}
                              label={sourceDestination.label}
                              ariaLabel={sourceDestination.label}
                              prefixLength={5}
                              suffixLength={5}
                              preserveCashAddressPrefix
                              maskLength={8}
                              revealOnClick
                              className="max-w-full break-all"
                            />
                          </div>
                        );
                      })()}
                      <div>
                        {t('wizard.txid')}:{' '}
                        <MaskedValue
                          value={binToHex(
                            ensureUint8Array(
                              tx.inputs[index].outpointTransactionHash
                            )
                          )}
                          label={t('history.transactionId')}
                          ariaLabel={t('history.transactionId')}
                          copySuccessMessageKey="history.transactionCopied"
                          className="max-w-full break-all"
                        />
                      </div>
                      <div>
                        {t('wizard.index')}: {tx.inputs[index].outpointIndex}
                      </div>
                      <div>
                        {Number(parseSatoshis(source.valueSatoshis)) /
                          SATSINBITCOIN}{' '}
                        BCH
                      </div>
                    </div>
                  ))}

                  {(outputs as TxOutput[]).map((output, index) => {
                    const value = parseSatoshis(output.valueSatoshis);
                    const lockingBytecode = ensureUint8Array(
                      output.lockingBytecode
                    );
                    const isOpReturn = lockingBytecode[0] === 0x6a;

                    if (isOpReturn) {
                      const parsed = parsePushData(lockingBytecode);
                      return (
                        <div
                          key={`${pending.request.sequence}-output-${index}`}
                          className="ml-2 space-y-1 border-b border-[var(--wallet-border)] pb-2 text-sm"
                        >
                          <strong>{t('wizard.opReturnOutput')}</strong>
                          {parsed.map((line, lineIndex) => (
                            <div
                              key={`${pending.request.sequence}-output-${index}-line-${lineIndex}`}
                              className="font-mono wallet-muted break-words"
                            >
                              {line}
                            </div>
                          ))}
                        </div>
                      );
                    }

                    const addressResult = lockingBytecodeToCashAddress({
                      prefix: PREFIX[network],
                      bytecode: lockingBytecode,
                    });
                    const address =
                      typeof addressResult === 'string'
                        ? addressResult
                        : addressResult.address;

                    return (
                      <div
                        key={`${pending.request.sequence}-standard-output-${index}`}
                        className="ml-2 border-b border-[var(--wallet-border)] pb-2 space-y-1"
                      >
                        <div>
                          {t('wizard.address')}:{' '}
                          <MaskedValue
                            value={address}
                            label={t('wizard.address')}
                            ariaLabel={t('receive.copyAddress')}
                            copySuccessMessageKey="receive.addressCopied"
                            prefixLength={5}
                            suffixLength={5}
                            preserveCashAddressPrefix
                            maskLength={8}
                            revealOnClick
                            className="max-w-full break-all"
                          />
                        </div>
                        <div>{Number(value) / SATSINBITCOIN} BCH</div>
                        {output.token && (
                          <div className="text-sm wallet-surface-strong border border-[var(--wallet-border)] rounded p-2 space-y-1">
                            <div>
                              <strong>{t('wizard.tokenCategory')}:</strong>{' '}
                              <span className="font-mono break-all">
                                {binToHex(
                                  ensureUint8Array(output.token.category)
                                )}
                              </span>
                            </div>
                            {output.token.amount !== undefined &&
                              output.token.amount !== null && (
                                <div>
                                  <strong>{t('wizard.fungibleAmount')}:</strong>{' '}
                                  {String(parseSatoshis(output.token.amount))}
                                </div>
                              )}
                            {output.token.nft && (
                              <>
                                <div>
                                  <strong>{t('wizard.nftCapability')}:</strong>{' '}
                                  {output.token.nft.capability}
                                </div>
                                <div>
                                  <strong>{t('wizard.nftCommitment')}:</strong>{' '}
                                  <span className="font-mono break-all">
                                    {binToHex(
                                      ensureUint8Array(
                                        output.token.nft.commitment
                                      )
                                    ) || 'empty'}
                                  </span>
                                </div>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </details>
            </>
          )}
        </div>

        <div className="flex justify-around pt-2">
          <button
            disabled={!canApprove || busy}
            onClick={() => void handleApprove()}
            className="wallet-btn-primary"
          >
            {busy ? t('wizard.working') : t('wizard.sign')}
          </button>
          <button
            onClick={() => void handleReject()}
            className="wallet-btn-danger"
            disabled={busy}
          >
            {t('wizard.cancel')}
          </button>
        </div>
      </div>
    </div>
  );
}
