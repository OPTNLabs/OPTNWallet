// src/components/RegularUTXOs.tsx

import { FaBitcoin } from 'react-icons/fa';
import { shortenTxHash } from '../utils/shortenHash';

const RegularUTXOs = ({ utxos, loading }) => {
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
          <div
            key={idx}
            className="p-3 mb-3 border rounded-lg grid grid-cols-[1fr_auto] gap-4"
          >
            <div className="space-y-1">
              <p className="break-words">
                <strong>Amount:</strong>{' '}
                {utxo.amount ? utxo.amount.toString() : utxo.value} satoshis
              </p>
              <p className="break-words">
                <strong>Tx Hash:</strong> {shortenTxHash(utxo.tx_hash)}
              </p>
              <p className="break-words">
                <strong>Position:</strong> {utxo.tx_pos}
              </p>
              <p className="break-words">
                <strong>Height:</strong> {utxo.height}
              </p>
            </div>
            <div className="flex flex-col items-center space-y-2">
              <FaBitcoin className="text-green-500 text-4xl " />
              <span className="text-base font-medium text-center">
                Bitcoin Cash
              </span>
            </div>
          </div>
        ))
      )}
    </div>
  );
};

export default RegularUTXOs;
