// src/components/transaction/TransactionActions.tsx

import React from 'react';

interface TransactionActionsProps {
  // totalSelectedUtxoAmount: bigint;
  loading: boolean;
  buildTransaction: () => void;
  sendTransaction: () => void;
  rawTX: string;
  // returnHome: () => void;
}

const TransactionActions: React.FC<TransactionActionsProps> = ({
  // totalSelectedUtxoAmount,
  loading,
  buildTransaction,
  sendTransaction,
  rawTX,
  // returnHome,
}) => {
  return (
    <>
      {/* <div className="mb-6">
        <h3 className="text-lg font-semibold mb-2">
          Total Selected UTXO Amount: {totalSelectedUtxoAmount.toString()}
        </h3>
      </div> */}

      {/* Spinning Loader */}
      {loading && (
        <div className="flex justify-center items-center mb-6">
          <div className="w-8 h-8 border-4 border-t-4 border-blue-500 rounded-full animate-spin"></div>
        </div>
      )}

      <div className="mb-6">
        <button
          onClick={buildTransaction}
          className="bg-green-500 font-bold text-white py-2 px-4 rounded mr-2"
        >
          Build TX
        </button>
        {rawTX.length > 0 && (
          <button
            onClick={sendTransaction}
            className="bg-red-500 font-bold text-white py-2 px-4 rounded"
          >
            Send TX
          </button>
        )}
      </div>
      {/* <button
        onClick={returnHome}
        className="bg-red-500 text-white py-2 px-4 rounded"
      >
        Go Back
      </button> */}
    </>
  );
};

export default TransactionActions;
