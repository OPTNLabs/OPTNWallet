import { useDispatch, useSelector } from 'react-redux';
import { Toast } from '@capacitor/toast';
import { binToHex, lockingBytecodeToCashAddress } from '@bitauth/libauth';
import type { AppDispatch, RootState } from '../../state/store';
import {
  approveWizardSignRequest,
  rejectWizardSignRequest,
} from '../../state/slices/wizardconnectSlice';
import { ensureUint8Array, parseSatoshis } from '../../utils/binary';
import { SATSINBITCOIN } from '../../utils/constants';
import { toErrorMessage } from '../../utils/errorHandling';
import { useI18n } from '../../i18n/useI18n';

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
type TxInputSource = TxAmountCarrier & {
  outpointTransactionHash: unknown;
  outpointIndex: number;
};

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
  const pending = useSelector(
    (state: RootState) => state.wizardconnect.pendingSignRequest
  );
  const connections = useSelector(
    (state: RootState) => state.wizardconnect.activeConnections
  );

  if (!pending) return null;

  const connection = connections[pending.connectionId];
  const payload = pending.request.transaction;
  const tx =
    payload.transaction && typeof payload.transaction === 'object'
      ? payload.transaction
      : null;
  const sourceOutputs = payload.sourceOutputs ?? [];
  const outputs = tx?.outputs ?? [];
  const totalInput = (sourceOutputs as TxInputSource[]).reduce(
    (sum, output) => sum + parseSatoshis(output.valueSatoshis),
    0n
  );
  const totalOutput = (outputs as TxOutput[]).reduce(
    (sum, output) => sum + parseSatoshis(output.valueSatoshis),
    0n
  );

  const handleApprove = async () => {
    try {
      await dispatch(approveWizardSignRequest()).unwrap();
      await Toast.show({ text: t('wizard.approved') });
    } catch (error) {
      console.error(
        '[WizardConnect] Failed to approve transaction request',
        error
      );
      await Toast.show({
        text: t('wizard.approveFailed', { message: toErrorMessage(error) }),
      });
    }
  };

  const handleReject = async () => {
    try {
      await dispatch(rejectWizardSignRequest()).unwrap();
      await Toast.show({ text: t('wizard.rejected') });
    } catch (error) {
      console.error(
        '[WizardConnect] Failed to reject transaction request',
        error
      );
      await Toast.show({
        text: t('wizard.rejectFailed', { message: toErrorMessage(error) }),
      });
    }
  };

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
              {connection?.status.status ?? 'pending'}
            </div>
          </div>

          {payload.userPrompt && (
            <p className="text-sm wallet-surface-strong border border-[var(--wallet-border)] rounded p-2 wallet-text-strong">
              <strong>{t('wizard.prompt')}:</strong> {payload.userPrompt}
            </p>
          )}

          {!tx && (
            <div className="text-sm wallet-surface-strong border border-[var(--wallet-border)] rounded p-3 wallet-text-strong">
              {t('wizard.unsupportedTransaction')}
            </div>
          )}

          {tx && (
            <>
              {(sourceOutputs as TxInputSource[]).map((source, index) => (
                <div
                  key={`${pending.request.sequence}-${index}`}
                  className="ml-2"
                >
                  <div>
                    {t('wizard.txid')}:{' '}
                    <span className="font-mono break-all">
                      {binToHex(
                        ensureUint8Array(source.outpointTransactionHash)
                      )}
                    </span>
                  </div>
                  <div>
                    {t('wizard.index')}: {source.outpointIndex}
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
                  prefix: 'bitcoincash',
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
                      <span className="font-mono wallet-link break-all">
                        {address}
                      </span>
                    </div>
                    <div>{Number(value) / SATSINBITCOIN} BCH</div>
                    {output.token && (
                      <div className="text-sm wallet-surface-strong border border-[var(--wallet-border)] rounded p-2 space-y-1">
                        <div>
                          <strong>{t('wizard.tokenCategory')}:</strong>{' '}
                          <span className="font-mono break-all">
                            {binToHex(ensureUint8Array(output.token.category))}
                          </span>
                        </div>
                        {output.token.amount !== undefined && output.token.amount !== null && (
                          <div>
                            <strong>{t('wizard.fungibleAmount')}:</strong>{' '}
                            {String(parseSatoshis(output.token.amount))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}

              <div className="text-sm border-t border-[var(--wallet-border)] pt-2">
                <div>
                  {t('wizard.totalInput')}: {Number(totalInput) / SATSINBITCOIN}{' '}
                  BCH
                </div>
                <div>
                  {t('wizard.totalOutput')}:{' '}
                  {Number(totalOutput) / SATSINBITCOIN} BCH
                </div>
                <div className="font-semibold">
                  {t('wizard.estimatedFee')}:{' '}
                  {Number(totalInput - totalOutput) / SATSINBITCOIN} BCH
                </div>
                <div>
                  {t('wizard.broadcast')}:{' '}
                  {payload.broadcast ? t('wizard.yes') : t('wizard.no')}
                </div>
              </div>
            </>
          )}
        </div>

        <div className="flex justify-around pt-2">
          <button
            onClick={() => void handleApprove()}
            className="wallet-btn-primary"
          >
            {t('wizard.sign')}
          </button>
          <button
            onClick={() => void handleReject()}
            className="wallet-btn-danger"
          >
            {t('wizard.cancel')}
          </button>
        </div>
      </div>
    </div>
  );
}
