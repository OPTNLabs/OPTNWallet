// src/components/transaction/AvailableUTXOsDisplay.tsx

import React from 'react';
import { UTXO } from '../../types/types';
import Popup from './Popup';
import { shortenTxHash } from '../../utils/shortenHash';
import { PREFIX } from '../../utils/constants';
import { Network } from '../../redux/networkSlice';

interface AvailableUTXOsDisplayProps {
  utxos: UTXO[]; // Regular UTXOs
  // contractUtxos: UTXO[]; // Contract UTXOs
  selectedUtxos: UTXO[];
  handleUtxoClick: (utxo: UTXO) => void;
  currentNetwork: Network;
  showCTUTXOs: boolean;
  setShowCTUTXOs: React.Dispatch<React.SetStateAction<boolean>>;
  closePopups: () => void;
}

const AvailableUTXOsDisplay: React.FC<AvailableUTXOsDisplayProps> = ({
  utxos,
  // contractUtxos,
  selectedUtxos,
  handleUtxoClick,
  currentNetwork,
  showCTUTXOs,
  setShowCTUTXOs,
  closePopups,
}) => {
  // Optionally filter UTXOs for those with tx_pos === 0
  const filteredRegularUTXOs = utxos.filter(
    (utxo) => utxo.tx_pos === 0 && !utxo.token
  );
  // const filteredContractUTXOs = contractUtxos.filter(
  //   (utxo) => utxo.tx_pos === 0
  // );

  return (
    <div className="mb-4">
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-lg font-semibold">CashToken Genesis UTXOs</h3>
        {/* {(filteredRegularUTXOs.length > 0 ||
          filteredContractUTXOs.length > 0) && ( */}
        {filteredRegularUTXOs.length > 0 && (
          <button
            onClick={() => setShowCTUTXOs(true)}
            className="bg-blue-500 font-bold text-white py-1 px-2 rounded hover:bg-blue-600 transition-colors duration-200"
          >
            Show
          </button>
        )}
      </div>

      {/* Show popup only if showCTUTXOs is true */}
      {showCTUTXOs && (
        <Popup closePopups={closePopups}>
          <h3 className="text-lg font-semibold mb-4">Available UTXOs</h3>

          <div className="max-h-[60vh]">
            {/* Regular UTXOs */}
            <div className="mb-6">
              <h4 className="font-semibold mb-2">Regular UTXOs</h4>
              <div className="max-h-[30vh] overflow-y-auto">
                {filteredRegularUTXOs.length === 0 ? (
                  <p>No regular UTXOs available.</p>
                ) : (
                  filteredRegularUTXOs.map((utxo) => {
                    const isSelected = selectedUtxos.some(
                      (selUtxo) =>
                        selUtxo.tx_hash === utxo.tx_hash &&
                        selUtxo.tx_pos === utxo.tx_pos
                    );

                    return (
                      <button
                        key={utxo.id ? utxo.id : utxo.tx_hash + utxo.tx_pos}
                        onClick={() => handleUtxoClick(utxo)}
                        className={`flex flex-col items-start mb-2 w-full break-words whitespace-normal border p-2 rounded
                          ${isSelected ? 'bg-blue-100' : 'bg-white'}`}
                      >
                        <span className="w-full">
                          {`Address: ${shortenTxHash(
                            utxo.address,
                            PREFIX[currentNetwork].length
                          )}`}
                        </span>
                        <span className="w-full">
                          {`Amount: ${utxo.amount ? utxo.amount : utxo.value} sats`}
                        </span>
                        <span className="w-full">
                          {`Tx Hash: ${shortenTxHash(utxo.tx_hash)}`}
                        </span>
                        <span className="w-full">{`Position: ${utxo.tx_pos}`}</span>
                      </button>
                    );
                  })
                )}
              </div>
            </div>

            {/* //Contract UTXOs
            <div className="mb-6">
              <h4 className="font-semibold mb-2">Contract UTXOs</h4>
              <div className="max-h-[20vh] overflow-y-auto">
                {filteredContractUTXOs.length === 0 ? (
                  <p>No contract UTXOs available.</p>
                ) : (
                  filteredContractUTXOs.map((utxo) => {
                    const isSelected = selectedUtxos.some(
                      (selUtxo) =>
                        selUtxo.tx_hash === utxo.tx_hash &&
                        selUtxo.tx_pos === utxo.tx_pos
                    );

                    return (
                      <button
                        key={utxo.id ? utxo.id : utxo.tx_hash + utxo.tx_pos}
                        onClick={() => handleUtxoClick(utxo)}
                        className={`flex flex-col items-start mb-2 w-full break-words whitespace-normal border p-2 rounded 
                          ${isSelected ? 'bg-blue-100' : 'bg-white'}`}
                      >
                        <span className="w-full">
                          {`Contract: ${shortenTxHash(
                            utxo.address,
                            PREFIX[currentNetwork].length
                          )}`}
                        </span>
                        <span className="w-full">
                          {`Amount: ${utxo.amount ? utxo.amount : utxo.value} sats`}
                        </span>
                        <span className="w-full">
                          {`Tx Hash: ${shortenTxHash(utxo.tx_hash)}`}
                        </span>
                        <span className="w-full">{`Position: ${utxo.tx_pos}`}</span>
                      </button>
                    );
                  })
                )}
              </div>
            </div> */}
          </div>
        </Popup>
      )}
    </div>
  );
};

export default AvailableUTXOsDisplay;
