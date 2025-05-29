// src/components/transaction/ErrorAndStatusPopups.tsx

import React, { useMemo } from 'react';
import Popup from './Popup';
import { Network } from '../../redux/networkSlice';
import { useNavigate } from 'react-router-dom';
import { useSelector } from 'react-redux';
import { RootState } from '../../redux/store';
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

interface ErrorAndStatusPopupsProps {
  showRawTxPopup: boolean;
  showTxIdPopup: boolean;
  rawTX: string;
  transactionId: string;
  errorMessage: string | null;
  currentNetwork: string;
  closePopups: () => void;
}

const ErrorAndStatusPopups: React.FC<ErrorAndStatusPopupsProps> = ({
  showRawTxPopup,
  showTxIdPopup,
  rawTX,
  transactionId,
  errorMessage,
  currentNetwork,
  closePopups,
}) => {
  const navigate = useNavigate();
  const walletId = useSelector(
    (state: RootState) => state.wallet_id.currentWalletId
  );

  const ensureUint8Array = (input: any): Uint8Array => {
    if (input instanceof Uint8Array) return input;
    if (typeof input === 'string' && input.startsWith('<Uint8Array: 0x')) {
      const hex = input.slice('<Uint8Array: 0x'.length, -1);
      const bytes = new Uint8Array(hex.length / 2);
      for (let i = 0; i < hex.length; i += 2) {
        bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
      }
      return bytes;
    }
    return new Uint8Array();
  };

  const toCashAddress = (
    bytecode: Uint8Array,
    prefix: 'bitcoincash' | 'bchtest' | 'bchreg'
  ): string => {
    try {
      const result = lockingBytecodeToCashAddress({ bytecode, prefix });
      return typeof result === 'string' ? `⚠️ ${result}` : result.address;
    } catch {
      return '⚠️ Invalid locking bytecode';
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
    if (showTxIdPopup && transactionId && walletId) {
      setTimeout(() => {
        navigate(`/home/${walletId}`, { state: { fromTxSuccess: true } });
      }, 300);
    }
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
          <h3 className="text-lg font-semibold mb-2">
            Raw Transaction Details
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
                <strong>Inputs:</strong>
                {decodedTx.inputs.map((input, idx) => (
                  <div key={idx} className="ml-4 mt-1">
                    <p>
                      • txid:{' '}
                      {Buffer.from(input.outpointTransactionHash)
                        .reverse()
                        .toString('hex')}
                    </p>
                    <p>• index: {input.outpointIndex}</p>
                    {/* <p>• sequence: {input.sequenceNumber}</p> */}
                  </div>
                ))}
              </div>

              <div className="mt-2">
                <strong>Outputs:</strong>
                {decodedTx.outputs.map((output, idx) => {
                  const value = output.valueSatoshis.toString();
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
                      <p>• value: {value} sats</p>

                      {isOpReturn ? (
                        <>
                          <p className="font-semibold text-gray-700">
                            OP_RETURN Output:
                          </p>
                          {parsePushData(lockingBytecode).map((entry, i) => (
                            <p
                              key={i}
                              className="text-gray-700 ml-2 text-xs font-mono"
                            >
                              {entry}
                            </p>
                          ))}
                        </>
                      ) : (
                        <>
                          <p>
                            • Address:{' '}
                            <span className="font-mono text-blue-600 break-all">
                              {toCashAddress(
                                lockingBytecode,
                                currentNetwork === Network.MAINNET
                                  ? 'bitcoincash'
                                  : 'bchtest'
                              )}
                            </span>
                          </p>
                        </>
                      )}

                      {token && (
                        <div className="bg-green-50 border border-green-200 rounded p-2 mt-2 space-y-1 text-xs">
                          <div>
                            <strong>Token Category:</strong>{' '}
                            <span className="font-mono break-all">
                              {binToHex(ensureUint8Array(token.category))}
                            </span>
                          </div>
                          {token.amount && (
                            <div>
                              <strong>Fungible Amount:</strong>{' '}
                              {typeof token.amount === 'bigint'
                                ? token.amount.toString()
                                : BigInt(token.amount).toString()}
                            </div>
                          )}
                          {token.nft && (
                            <>
                              <div>
                                <strong>NFT Capability:</strong>{' '}
                                {token.nft.capability}
                              </div>
                              {token.nft.commitment && (
                                <div>
                                  <strong>NFT Commitment:</strong>{' '}
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
              <p className="text-sm mb-2 text-red-600">
                Unable to decode transaction. Showing raw hex:
              </p>
              <textarea
                readOnly
                value={rawTX}
                className="w-full h-40 p-2 border rounded text-xs"
              />
            </>
          )}
        </Popup>
      )}

      {showTxIdPopup && transactionId && (
        <Popup closePopups={handleClose}>
          <h3 className="text-lg font-semibold mb-2">Transaction Successful</h3>
          <p>Your transaction has been broadcasted successfully!</p>
          <p>
            <strong>Transaction ID:</strong> {transactionId}
          </p>
          <p>
            <a
              href={
                currentNetwork === Network.CHIPNET
                  ? `https://chipnet.bch.ninja/tx/${transactionId}`
                  : `https://explorer.bch.ninja/tx/${transactionId}`
              }
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-500 underline"
            >
              View on Explorer
            </a>
          </p>
        </Popup>
      )}

      {errorMessage && (
        <Popup closePopups={closePopups}>
          <h3 className="text-lg font-semibold mb-2">Error</h3>
          <p>{errorMessage}</p>
        </Popup>
      )}
    </>
  );
};

export default ErrorAndStatusPopups;
