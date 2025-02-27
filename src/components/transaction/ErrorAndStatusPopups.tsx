// src/components/transaction/ErrorAndStatusPopups.tsx

import React from 'react';
import Popup from './Popup';
import { Network } from '../../redux/networkSlice';

interface ErrorAndStatusPopupsProps {
  showRawTxPopup: boolean;
  showTxIdPopup: boolean;
  rawTX: string;
  transactionId: string;
  errorMessage: string | null;
  currentNetwork: string; // Adjust the type based on your Network type
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
  return (
    <>
      {/* Raw Transaction Popup */}
      {showRawTxPopup && (
        <Popup closePopups={closePopups}>
          <h3 className="text-lg font-semibold mb-2">Raw Transaction</h3>
          <textarea
            readOnly
            value={rawTX}
            className="w-full h-40 p-2 border rounded"
          />
        </Popup>
      )}

      {/* Transaction ID Popup */}
      {showTxIdPopup && transactionId && (
        <Popup closePopups={closePopups}>
          <h3 className="text-lg font-semibold mb-2">Transaction Successful</h3>
          <p>Your transaction has been broadcasted successfully!</p>
          <p>
            <strong>Transaction ID:</strong> {transactionId}
          </p>
          <p>
            <a
              href={
                currentNetwork === Network.CHIPNET
                  ? `https://chipnet.imaginary.cash/tx/${transactionId}`
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

      {/* Error Message Popup */}
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
