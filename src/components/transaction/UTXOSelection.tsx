// src/components/transaction/UTXOSelection.tsx

import React from 'react';
import { UTXO } from '../../types/types';
import RegularUTXOs from '../RegularUTXOs';
import CashTokenUTXOs from '../CashTokenUTXOs';
import Popup from './Popup';

interface UTXOSelectionProps {
  selectedAddresses: string[];
  selectedContractAddresses: string[];
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
  paperWalletUTXOs: UTXO[];
  showPaperWalletUTXOsPopup: boolean;
  setShowPaperWalletUTXOsPopup: React.Dispatch<React.SetStateAction<boolean>>;
  // selectedPaperWalletUTXOs: UTXO[]; // New prop to receive paper wallet UTXOs
  closePopups: () => void;
}

const UTXOSelection: React.FC<UTXOSelectionProps> = ({
  selectedAddresses,
  selectedContractAddresses,
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
  paperWalletUTXOs,
  showPaperWalletUTXOsPopup,
  setShowPaperWalletUTXOsPopup,
  // selectedPaperWalletUTXOs,
  closePopups,
}) => {
  // Compute regular addresses by excluding contract addresses
  const regularAddresses = selectedAddresses.filter(
    (addr) => !selectedContractAddresses.includes(addr)
  );

  return (
    <div className="flex flex-wrap gap-2 justify-center">
      {/* Regular UTXOs Button and Popup */}
      <div>
        {regularAddresses.length > 0 && (
          <button
            className="bg-blue-500 text-sm font-bold text-white py-2 px-4 rounded mb-2"
            onClick={() => setShowRegularUTXOsPopup(true)}
          >
            Regular UTXOs
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
      <div>
        {regularAddresses.length > 0 && (
          <button
            className="bg-blue-500 text-sm font-bold text-white py-2 px-4 rounded mb-2"
            onClick={() => setShowCashTokenUTXOsPopup(true)}
          >
            CashToken UTXOs
          </button>
        )}
        {showCashTokenUTXOsPopup && (
          <Popup closePopups={closePopups}>
            <h4 className="text-md font-semibold mb-4">CashToken UTXOs</h4>
            <div className="overflow-y-auto max-h-80 space-y-4">
              {(() => {
                const fungible = filteredCashTokenUTXOs.filter(
                  (u) => !u.token?.nft
                );
                const nonFungible = filteredCashTokenUTXOs.filter(
                  (u) => !!u.token?.nft
                );
                return (
                  <>
                    {fungible.length > 0 && (
                      <div>
                        <h5 className="font-semibold mb-2">Fungible Tokens</h5>
                        {fungible.map((utxo) => (
                          <button
                            key={utxo.id}
                            onClick={() => handleUtxoClick(utxo)}
                            className={`block w-full text-left p-2 mb-2 border rounded-lg break-words whitespace-normal ${
                              selectedUtxos.some(
                                (s) =>
                                  s.tx_hash === utxo.tx_hash &&
                                  s.tx_pos === utxo.tx_pos
                              )
                                ? 'bg-blue-100'
                                : 'bg-white'
                            }`}
                          >
                            <CashTokenUTXOs utxos={[utxo]} loading={false} />
                          </button>
                        ))}
                      </div>
                    )}

                    {nonFungible.length > 0 && (
                      <div>
                        <h5 className="font-semibold mb-2">
                          Non-Fungible Tokens
                        </h5>
                        {nonFungible.map((utxo) => (
                          <button
                            key={utxo.id}
                            onClick={() => handleUtxoClick(utxo)}
                            className={`block w-full text-left p-2 mb-2 border rounded-lg break-words whitespace-normal ${
                              selectedUtxos.some(
                                (s) =>
                                  s.tx_hash === utxo.tx_hash &&
                                  s.tx_pos === utxo.tx_pos
                              )
                                ? 'bg-blue-100'
                                : 'bg-white'
                            }`}
                          >
                            <CashTokenUTXOs utxos={[utxo]} loading={false} />
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                );
              })()}
            </div>
          </Popup>
        )}
      </div>

      {/* Contract UTXOs Button and Popup */}
      <div>
        {selectedContractAddresses.length > 0 && (
          <button
            className="bg-blue-500 text-sm font-bold text-white py-2 px-4 rounded mb-2"
            onClick={() => {
              setShowContractUTXOsPopup(true);
            }}
          >
            Contract UTXOs
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
      {/* Paper Wallet UTXOs Button and Popup */}
      <div className="mb-4">
        {paperWalletUTXOs.length > 0 && (
          <button
            className="bg-green-500 font-bold text-sm  text-white py-2 px-4 rounded mb-2 mr-2"
            onClick={() => setShowPaperWalletUTXOsPopup(true)}
          >
            Paper Wallet
          </button>
        )}
        {showPaperWalletUTXOsPopup && (
          <Popup closePopups={closePopups}>
            <h4 className="text-md font-semibold mb-4">Paper Wallet UTXOs</h4>
            <div className="overflow-y-auto max-h-80">
              {paperWalletUTXOs.map((utxo) => (
                <button
                  key={utxo.id ? utxo.id : utxo.tx_hash + utxo.tx_pos}
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
    </div>
  );
};

export default UTXOSelection;
