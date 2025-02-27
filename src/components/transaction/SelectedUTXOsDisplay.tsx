// src/components/transaction/SelectedUTXOsDisplay.tsx

import React, { useState } from 'react';
import { UTXO } from '../../types/types';
import Popup from './Popup'; // Import the Popup component
import { shortenTxHash } from '../../utils/shortenHash';
import { PREFIX } from '../../utils/constants';
import { Network } from '../../redux/networkSlice';

interface SelectedUTXOsDisplayProps {
  selectedUtxos: UTXO[];
  totalSelectedUtxoAmount: BigInt;
  handleUtxoClick: (utxo: UTXO) => void;
  currentNetwork: Network;
}

const SelectedUTXOsDisplay: React.FC<SelectedUTXOsDisplayProps> = ({
  selectedUtxos,
  totalSelectedUtxoAmount,
  handleUtxoClick,
  currentNetwork,
}) => {
  const [showPopup, setShowPopup] = useState<boolean>(false); // Local state for popup visibility

  // Function to toggle the popup
  const togglePopup = () => {
    setShowPopup((prev) => !prev);
  };

  return (
    <div className="mb-4">
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-lg font-semibold">Transaction Inputs</h3>

        {selectedUtxos.length > 0 && (
          <button
            onClick={togglePopup}
            className="bg-blue-500 font-bold text-white py-1 px-2 rounded hover:bg-blue-600 transition-colors duration-200 "
          >
            Show
          </button>
        )}
      </div>

      {/* Conditional Rendering: Show in-place or in Popup */}
      {showPopup && (
        // Popup Display of UTXOs
        <Popup closePopups={() => setShowPopup(false)}>
          <h3 className="text-lg font-semibold mb-4">Transaction Inputs</h3>
          <div className="max-h-[50vh] overflow-y-auto">
            {selectedUtxos.length === 0 ? (
              <p>No UTXOs selected.</p>
            ) : (
              selectedUtxos.map((utxo) => (
                <button
                  key={utxo.id ? utxo.id : utxo.tx_hash + utxo.tx_pos}
                  onClick={() => handleUtxoClick(utxo)}
                  className="flex flex-col items-start mb-2 w-full break-words whitespace-normal border p-2 rounded bg-blue-100"
                >
                  <span className="w-full">{`Address: ${shortenTxHash(
                    utxo.address,
                    PREFIX[currentNetwork].length
                  )}`}</span>
                  <span className="w-full">{`Amount: ${utxo.amount ? utxo.amount : utxo.value} sats`}</span>
                  <span className="w-full">{`Tx Hash: ${shortenTxHash(utxo.tx_hash)}`}</span>
                  <span className="w-full">{`Position: ${utxo.tx_pos}`}</span>
                  {utxo.contractFunction && (
                    <span className="w-full">{`Contract Function: ${utxo.contractFunction}`}</span>
                  )}
                  {!utxo.unlocker && utxo.abi && (
                    <span className="text-red-500 w-full">
                      Missing unlocker!
                    </span>
                  )}
                </button>
              ))
            )}
          </div>
        </Popup>
      )}
      {selectedUtxos.length > 0 && (
        <div className="mt-4">
          <h3 className="text-lg font-semibold">
            {`${selectedUtxos.length} Input${selectedUtxos.length === 1 ? `` : `s`} - Total: ${totalSelectedUtxoAmount.toString()}`}
          </h3>
        </div>
      )}
    </div>
  );
};

export default SelectedUTXOsDisplay;
