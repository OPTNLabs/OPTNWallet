// src/components/transaction/UTXOSelection.tsx

import React from 'react';
import { UTXO } from '../../types/types';
import RegularUTXOs from '../RegularUTXOs';
import CashTokenUTXOs from '../CashTokenUTXOs';
import Popup from './Popup';

interface UTXOSelectionProps {
  selectedAddresses: string[];
  contractAddresses: {
    address: string;
    tokenAddress: string;
    contractName: string;
    abi: any[];
  }[];
  filteredRegularUTXOs: UTXO[];
  filteredCashTokenUTXOs: UTXO[];
  filteredContractUTXOs: UTXO[];
  selectedUtxos: UTXO[];
  handleUtxoClick: (utxo: UTXO) => void;
  showRegularUTXOsPopup: boolean;
  setShowRegularUTXOsPopup: React.Dispatch<React.SetStateAction<boolean>>;
  showCashTokenUTXOsPopup: boolean;
  setShowCashTokenUTXOsPopup: React.Dispatch<React.SetStateAction<boolean>>;
  showContractUTXOsPopup: boolean;
  setShowContractUTXOsPopup: React.Dispatch<React.SetStateAction<boolean>>;
  closePopups: () => void;
}

const UTXOSelection: React.FC<UTXOSelectionProps> = ({
  selectedAddresses,
  contractAddresses,
  filteredRegularUTXOs,
  filteredCashTokenUTXOs,
  filteredContractUTXOs,
  selectedUtxos,
  handleUtxoClick,
  showRegularUTXOsPopup,
  setShowRegularUTXOsPopup,
  showCashTokenUTXOsPopup,
  setShowCashTokenUTXOsPopup,
  showContractUTXOsPopup,
  setShowContractUTXOsPopup,
  closePopups,
}) => {
  return (
    <>
      {/* Regular UTXOs Button and Popup */}
      <div>
        {selectedAddresses.length > 0 && (
          <button
            className="bg-blue-500 text-white py-2 px-4 rounded mb-2"
            onClick={() => setShowRegularUTXOsPopup(true)}
          >
            View Regular UTXOs
          </button>
        )}
        {showRegularUTXOsPopup && (
          <Popup closePopups={closePopups}>
            <h4 className="text-md font-semibold mb-4">Regular UTXOs</h4>
            <div className="overflow-y-auto max-h-80">
              {filteredRegularUTXOs.map((utxo) => (
                <button
                  key={utxo.id}
                  onClick={() => handleUtxoClick(utxo)}
                  className={`block w-full text-left p-2 mb-2 border rounded-lg break-words whitespace-normal ${
                    selectedUtxos.some(
                      (selectedUtxo) =>
                        selectedUtxo.tx_hash === utxo.tx_hash &&
                        selectedUtxo.tx_pos === utxo.tx_pos
                    )
                      ? 'bg-blue-100'
                      : 'bg-white'
                  }`}
                >
                  <RegularUTXOs utxos={[utxo]} loading={false} />
                </button>
              ))}
            </div>
          </Popup>
        )}
      </div>

      {/* CashToken UTXOs Button and Popup */}
      {/* <div>
        {selectedAddresses.length > 0 && (
          <button
            className="bg-blue-500 text-white py-2 px-4 rounded mb-2"
            onClick={() => setShowCashTokenUTXOsPopup(true)}
          >
            View CashToken UTXOs
          </button>
        )}
        {showCashTokenUTXOsPopup && (
          <Popup closePopups={closePopups}>
            <h4 className="text-md font-semibold mb-4">CashToken UTXOs</h4>
            <div className="overflow-y-auto max-h-80">
              {filteredCashTokenUTXOs.map((utxo) => (
                <button
                  key={utxo.id}
                  onClick={() => handleUtxoClick(utxo)}
                  className={`block w-full text-left p-2 mb-2 border rounded-lg break-words whitespace-normal ${
                    selectedUtxos.some(
                      (selectedUtxo) =>
                        selectedUtxo.tx_hash === utxo.tx_hash &&
                        selectedUtxo.tx_pos === utxo.tx_pos
                    )
                      ? 'bg-blue-100'
                      : 'bg-white'
                  }`}
                >
                  <CashTokenUTXOs utxos={[utxo]} loading={false} />
                </button>
              ))}
            </div>
          </Popup>
        )}
      </div> */}

      {/* Contract UTXOs Button and Popup */}
      <div className="mb-6">
        {contractAddresses.length > 0 && (
          <button
            className="bg-blue-500 text-white py-2 px-4 rounded mb-2"
            onClick={() => setShowContractUTXOsPopup(true)}
          >
            View Contract UTXOs
          </button>
        )}
        {showContractUTXOsPopup && (
          <Popup closePopups={closePopups}>
            <h4 className="text-md font-semibold mb-4">Contract UTXOs</h4>
            <div className="overflow-y-auto max-h-80">
              {filteredContractUTXOs.map((utxo) => (
                <button
                  key={utxo.id}
                  onClick={() => handleUtxoClick(utxo)}
                  className={`block w-full text-left p-2 mb-2 border rounded-lg break-words whitespace-normal ${
                    selectedUtxos.some(
                      (selectedUtxo) =>
                        selectedUtxo.tx_hash === utxo.tx_hash &&
                        selectedUtxo.tx_pos === utxo.tx_pos
                    )
                      ? 'bg-blue-100'
                      : 'bg-white'
                  }`}
                >
                  <RegularUTXOs utxos={[utxo]} loading={false} />
                </button>
              ))}
            </div>
          </Popup>
        )}
      </div>
    </>
  );
};

export default UTXOSelection;
