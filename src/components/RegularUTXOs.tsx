// src/components/RegularUTXOs.tsx
import React from 'react';

const RegularUTXOs = ({ address, utxos, loading }) => {
  return (
    <div>
      <h4 className="font-semibold">Regular UTXOs:</h4>
      {loading ? (
        <div className="flex items-center">
          <svg
            className="animate-spin h-5 w-5 mr-3 text-gray-500"
            viewBox="0 0 24 24"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            ></circle>
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8v8H4z"
            ></path>
          </svg>
          <span>Loading UTXOs...</span>
        </div>
      ) : (
        utxos &&
        utxos.map((utxo, idx) => (
          <div key={idx} className="p-2 mb-2 border rounded-lg overflow-x-auto">
            <p className="break-words">
              <strong>Amount:</strong> {utxo.amount}
            </p>
            <p className="break-words">
              <strong>Transaction Hash:</strong> {utxo.tx_hash}
            </p>
            <p className="break-words">
              <strong>Position:</strong> {utxo.tx_pos}
            </p>
            <p className="break-words">
              <strong>Height:</strong> {utxo.height}
            </p>
          </div>
        ))
      )}
    </div>
  );
};

export default RegularUTXOs;
