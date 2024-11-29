// src/components/transaction/ErrorAndStatusPopups.tsx

import React from 'react';
import Popup from './Popup';
import { Network } from '../../redux/networkSlice';

interface ErrorAndStatusPopupsProps {
  showRawTxPopup: boolean;
  // setShowRawTxPopup: React.Dispatch<React.SetStateAction<boolean>>;
  showTxIdPopup: boolean;
  // setShowTxIdPopup: React.Dispatch<React.SetStateAction<boolean>>;
  rawTX: string;
  transactionId: string;
  errorMessage: string | null;
  currentNetwork: Network;
  closePopups: () => void;
}

const ErrorAndStatusPopups: React.FC<ErrorAndStatusPopupsProps> = ({
  showRawTxPopup,
  // setShowRawTxPopup,
  showTxIdPopup,
  // setShowTxIdPopup,
  rawTX,
  transactionId,
  errorMessage,
  currentNetwork,
  closePopups,
}) => {
  return (
    <>
      {/* Raw Transaction Popup */}
      {showRawTxPopup && (
        <Popup closePopups={closePopups}>
          <h3 className="text-lg font-semibold mb-4">Raw Transaction</h3>
          <div className="text-sm font-medium text-gray-700 break-words whitespace-normal mb-4">
            {errorMessage ? (
              <div className="text-red-500">{errorMessage}</div>
            ) : (
              rawTX
            )}
          </div>
        </Popup>
      )}

      {/* Transaction ID Popup */}
      {showTxIdPopup && (
        <Popup closePopups={closePopups}>
          <h3 className="text-lg font-semibold mb-4">Transaction ID</h3>
          <div className="text-sm font-medium text-gray-700 break-words whitespace-normal mb-4">
            {errorMessage ? (
              <div className="text-red-500">{errorMessage}</div>
            ) : (
              <a
                className="text-blue-500 underline"
                href={
                  currentNetwork === Network.CHIPNET
                    ? `https://chipnet.imaginary.cash/tx/${transactionId}`
                    : `https://blockchair.com/bitcoin-cash/transaction/${transactionId}`
                }
                target="_blank"
                rel="noopener noreferrer"
              >
                {transactionId}
              </a>
            )}
          </div>
        </Popup>
      )}
    </>
  );
};

export default ErrorAndStatusPopups;
