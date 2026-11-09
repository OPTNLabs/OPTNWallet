// src/components/transaction/ErrorAndStatusPopups.tsx

import React, { useMemo } from 'react';
import Popup from './Popup';
import { Network } from '../../../state/slices/networkSlice';
import ExplorerLink from '../../../components/ExplorerLink';
import {
  binToHex,
  decodeTransactionCommon,
  hexToBin,
  Input,
  lockingBytecodeToCashAddress,
  Output,
  TransactionCommon,
  // type TransactionCommon,
} from '@bitauth/libauth';
import { SATSINBITCOIN } from '../../../utils/constants';
import { ensureUint8Array } from '../../../utils/binary';
import { type BroadcastState } from '../../../services/TransactionService';
import { useI18n } from '../../../i18n/useI18n';
import MaskedValue from '../../../components/ui/MaskedValue';
import FriendlyErrorPanel from '../../../components/ui/FriendlyErrorPanel';
import { cashAddressPrefix, parseNetwork } from '../../../utils/networkProfile';

interface ErrorAndStatusPopupsProps {
  showRawTxPopup: boolean;
  showTxIdPopup: boolean;
  rawTX: string;
  transactionId: string;
  errorMessage: string | null;
  currentNetwork: string;
  broadcastState?: BroadcastState;
  closePopups: () => void;
}

function friendlyBuilderError(
  message: string,
  t: ReturnType<typeof useI18n>['t']
): string {
  const normalized = message.toLowerCase();
  if (
    normalized.includes('insufficient funds') ||
    normalized.includes('output amount exceeds inputs')
  ) {
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

const ErrorAndStatusPopups: React.FC<ErrorAndStatusPopupsProps> = ({
  showRawTxPopup,
  showTxIdPopup,
  rawTX,
  transactionId,
  errorMessage,
  currentNetwork,
  broadcastState,
  closePopups,
}) => {
  const { t } = useI18n();
  const network = parseNetwork(currentNetwork) ?? Network.MAINNET;
  const toCashAddress = (
    bytecode: Uint8Array,
    prefix: 'bitcoincash' | 'bchtest' | 'bchreg'
  ): string => {
    try {
      const result = lockingBytecodeToCashAddress({ bytecode, prefix });
      return typeof result === 'string' ? `⚠️ ${result}` : result.address;
    } catch {
      return `⚠️ ${t('wc.invalidLockingBytecode')}`;
    }
  };

  const parsePushData = (bytecode: Uint8Array): string[] => {
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
  };

  const handleClose = () => {
    closePopups();
  };

  // Decode transaction using libauth
  const decodedTx = useMemo(() => {
    try {
      const bin = hexToBin(rawTX);
      const result = decodeTransactionCommon(bin);
      return typeof result === 'string'
        ? null
        : (result as TransactionCommon<Input, Output>);
    } catch (e) {
      console.error('Failed to decode transaction:', e);
      return null;
    }
  }, [rawTX]);

  return (
    <>
      {showRawTxPopup && (
        <Popup closePopups={closePopups}>
          <h3 className="text-lg font-semibold flex flex-col items-center mb-2">
            {t('builder.rawTransactionDetails')}
          </h3>
          {decodedTx ? (
            <div className="text-sm max-h-[60vh] overflow-y-auto">
              {/* <p>
                <strong>Version:</strong> {decodedTx.version}
              </p>
              <p>
                <strong>Locktime:</strong> {decodedTx.locktime}
              </p> */}

              <div className="mt-2">
                <strong className="flex flex-col items-center">
                  {t('builder.inputs')}
                </strong>
                {decodedTx.inputs.map((input, idx) => (
                  <div key={idx} className="ml-4 mt-1">
                    <p>
                      • {t('txDetails.txid')}:{' '}
                      <MaskedValue
                        value={Buffer.from(input.outpointTransactionHash)
                          .reverse()
                          .toString('hex')}
                        label={t('history.transactionId')}
                        ariaLabel={t('history.transactionId')}
                        copySuccessMessageKey="history.transactionCopied"
                        className="max-w-full align-middle"
                      />
                    </p>
                    <p>
                      • {t('txDetails.index')}: {input.outpointIndex}
                    </p>
                    {/* <p>• sequence: {input.sequenceNumber}</p> */}
                  </div>
                ))}
              </div>

              <div className="mt-2">
                <strong className="flex flex-col items-center">
                  {t('builder.outputs')}
                </strong>
                {decodedTx.outputs.map((output, idx) => {
                  const value = output.valueSatoshis;
                  const lockingBytecode = ensureUint8Array(
                    output.lockingBytecode
                  );
                  const isOpReturn = lockingBytecode[0] === 0x6a;
                  const token = output.token;

                  return (
                    <div
                      key={idx}
                      className="ml-4 mt-2 border-b pb-2 space-y-1 text-sm"
                    >
                      <p>
                        • {Number(value) / SATSINBITCOIN} {t('txDetails.bch')}
                      </p>

                      {isOpReturn ? (
                        <>
                          <p className="font-semibold wallet-muted">
                            {t('builder.opReturnOutput')}:
                          </p>
                          {parsePushData(lockingBytecode).map((entry, i) => (
                            <p
                              key={i}
                              className="wallet-muted ml-2 text-xs font-mono"
                            >
                              {entry}
                            </p>
                          ))}
                        </>
                      ) : (
                        <>
                          <p>
                            • {t('builder.address')}:{' '}
                            <MaskedValue
                              value={toCashAddress(
                                lockingBytecode,
                                cashAddressPrefix(network)
                              )}
                              label={t('receive.copyAddress')}
                              ariaLabel={t('receive.copyAddress')}
                              copySuccessMessageKey="receive.addressCopied"
                              className="max-w-full break-all"
                            />
                          </p>
                        </>
                      )}

                      {token && (
                        <div className="wallet-surface-strong border border-[var(--wallet-border)] rounded p-2 mt-2 space-y-1 text-xs">
                          <div>
                            <strong>{t('builder.tokenCategoryLabel')}:</strong>{' '}
                            <span className="font-mono break-all">
                              {binToHex(ensureUint8Array(token.category))}
                            </span>
                          </div>
                          {token.amount !== undefined && (
                            <div>
                              <strong>{t('builder.fungibleAmount')}:</strong>{' '}
                              {typeof token.amount === 'bigint'
                                ? token.amount.toString()
                                : BigInt(token.amount).toString()}
                            </div>
                          )}
                          {token.nft && (
                            <>
                              <div>
                                <strong>{t('builder.nftCapability')}:</strong>{' '}
                                {token.nft.capability}
                              </div>
                              {token.nft.commitment && (
                                <div>
                                  <strong>{t('builder.nftCommitment')}:</strong>{' '}
                                  <span className="font-mono break-all">
                                    {binToHex(
                                      ensureUint8Array(token.nft.commitment)
                                    )}
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
            </div>
          ) : (
            <>
              <p className="text-sm mb-2 wallet-danger-text">
                {t('builder.decodeFailed')}
              </p>
              <textarea
                readOnly
                value={rawTX}
                className="w-full h-40 p-2 border rounded text-xs wallet-input"
              />
            </>
          )}
        </Popup>
      )}

      {showTxIdPopup && transactionId && (
        <Popup closePopups={handleClose}>
          <div className="flex flex-col items-center p-4">
            <div className="wallet-accent-icon text-4xl mb-4">✅</div>
            <h3 className="text-xl font-bold mb-2">
              {broadcastState === 'submitted'
                ? t('builder.transactionSubmitted')
                : t('builder.transactionSuccessful')}
            </h3>
            <p className="text-center mb-4">
              {broadcastState === 'submitted'
                ? t('builder.transactionSubmittedDescription')
                : t('builder.broadcastedSuccess')}
            </p>
            <div className="flex items-center mb-4">
              <strong className="mr-2">{t('builder.txId')}:</strong>
              <MaskedValue
                value={transactionId}
                label={t('history.transactionId')}
                ariaLabel={t('history.transactionId')}
                copySuccessMessageKey="history.transactionCopied"
                className="max-w-full"
              />
            </div>
            <ExplorerLink
              network={
                currentNetwork === Network.CHIPNET
                  ? Network.CHIPNET
                  : Network.MAINNET
              }
              txid={transactionId}
              className="wallet-btn-primary py-2 px-4"
              label={t('builder.viewExplorer')}
            />
          </div>
        </Popup>
      )}

      {errorMessage && (
        <Popup closePopups={closePopups} closeButtonText={t('builder.close')}>
          <div className="flex flex-col items-center p-6">
            <div className="wallet-danger-text text-4xl mb-4">⚠️</div>
            <FriendlyErrorPanel
              title={t('builder.transactionError')}
              message={friendlyBuilderError(errorMessage, t)}
              className="w-full text-left"
            />
            <details className="mt-4 w-full">
              <summary className="flex min-h-[44px] cursor-pointer items-center text-sm font-semibold wallet-muted">
                {t('send.technicalDetails')}
              </summary>
              <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-[var(--wallet-border)] wallet-surface-strong p-3 text-left text-xs wallet-muted">
                {errorMessage}
              </pre>
            </details>
            <button
              onClick={closePopups}
              className="wallet-btn-danger mt-4 min-h-[44px] px-6"
            >
              {t('builder.tryAgain')}
            </button>
          </div>
        </Popup>
      )}
    </>
  );
};

export default ErrorAndStatusPopups;
