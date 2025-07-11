// @ts-nocheck

// src/components/transaction/UTXOSelection.tsx

import React, { useState } from 'react';
import { UTXO } from '../../types/types';
import UTXOCard from '../UTXOCard';
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
  showContractUTXOsPopup: boolean;
  setShowContractUTXOsPopup: React.Dispatch<React.SetStateAction<boolean>>;
  showCashTokenUTXOsPopup: boolean;
  setShowCashTokenUTXOsPopup: React.Dispatch<React.SetStateAction<boolean>>;
  paperWalletUTXOs: UTXO[];
  showPaperWalletUTXOsPopup: boolean;
  setShowPaperWalletUTXOsPopup: React.Dispatch<React.SetStateAction<boolean>>;
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
  paperWalletUTXOs,
  showPaperWalletUTXOsPopup,
  setShowPaperWalletUTXOsPopup,
  closePopups,
}) => {
  // State for selected view in Regular UTXOs popup
  const [regularView, setRegularView] = useState<'Wallet' | 'Contract'>(
    'Wallet'
  );
  // State for selected view in CashToken UTXOs popup
  const [cashTokenView, setCashTokenView] = useState<'Wallet' | 'Contract'>(
    'Wallet'
  );

  // Compute regular addresses by excluding contract addresses
  const regularAddresses = selectedAddresses.filter(
    (addr) => !selectedContractAddresses.includes(addr)
  );

  // Split contract UTXOs into regular (non-token) and cash token (token) categories
  const contractRegularUTXOs = filteredContractUTXOs.filter(
    (utxo) => !utxo.token
  );
  const contractCashTokenUTXOs = filteredContractUTXOs.filter(
    (utxo) => utxo.token
  );

  return (
    <div className="flex flex-wrap gap-2 justify-center">
      {/* Regular UTXOs Button and Popup */}
      <div>
        {(filteredRegularUTXOs.length > 0 ||
          contractRegularUTXOs.length > 0) && (
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
            <div className="flex justify-between mb-4">
              <button
                className={`py-2 px-4 rounded ${
                  regularView === 'Wallet'
                    ? 'bg-blue-500 text-white'
                    : 'bg-gray-200 text-black'
                }`}
                onClick={() => setRegularView('Wallet')}
              >
                Wallet
              </button>
              <button
                className={`py-2 px-4 rounded ${
                  regularView === 'Contract'
                    ? 'bg-blue-500 text-white'
                    : 'bg-gray-200 text-black'
                }`}
                onClick={() => setRegularView('Contract')}
              >
                Contract
              </button>
            </div>
            <div className="overflow-y-auto max-h-80 space-y-4">
              {regularView === 'Wallet' && (
                <div>
                  <h5 className="font-semibold mb-2">From Wallet Addresses</h5>
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
                      <UTXOCard utxos={[utxo]} loading={false} />
                    </button>
                  ))}
                </div>
              )}
              {regularView === 'Contract' && (
                <div>
                  <h5 className="font-semibold mb-2">
                    From Contract Addresses
                  </h5>
                  {contractRegularUTXOs.map((utxo) => (
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
                      <UTXOCard utxos={[utxo]} loading={false} />
                    </button>
                  ))}
                </div>
              )}
            </div>
          </Popup>
        )}
      </div>

      {/* CashToken UTXOs Button and Popup */}
      <div>
        {(filteredCashTokenUTXOs.length > 0 ||
          contractCashTokenUTXOs.length > 0) && (
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
            <div className="flex justify-between mb-4">
              <button
                className={`py-2 px-4 rounded ${
                  cashTokenView === 'Wallet'
                    ? 'bg-blue-500 text-white'
                    : 'bg-gray-200 text-black'
                }`}
                onClick={() => setCashTokenView('Wallet')}
              >
                Wallet
              </button>
              <button
                className={`py-2 px-4 rounded ${
                  cashTokenView === 'Contract'
                    ? 'bg-blue-500 text-white'
                    : 'bg-gray-200 text-black'
                }`}
                onClick={() => setCashTokenView('Contract')}
              >
                Contract
              </button>
            </div>
            <div className="overflow-y-auto max-h-80 space-y-4">
              {cashTokenView === 'Wallet' && (
                <div>
                  <h5 className="font-semibold mb-2">From Wallet Addresses</h5>
                  <div className="space-y-4">
                    {/* Fungible Tokens */}
                    {filteredCashTokenUTXOs.filter((u) => !u.token?.nft)
                      .length > 0 && (
                      <div>
                        <h6 className="font-semibold mb-2">Fungible Tokens</h6>
                        {filteredCashTokenUTXOs
                          .filter((u) => !u.token?.nft)
                          .map((utxo) => (
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
                              <UTXOCard utxos={[utxo]} loading={false} />
                            </button>
                          ))}
                      </div>
                    )}
                    {/* Non-Fungible Tokens */}
                    {filteredCashTokenUTXOs.filter((u) => u.token?.nft).length >
                      0 && (
                      <div>
                        <h6 className="font-semibold mb-2">
                          Non-Fungible Tokens
                        </h6>
                        {filteredCashTokenUTXOs
                          .filter((u) => u.token?.nft)
                          .map((utxo) => (
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
                              <UTXOCard utxos={[utxo]} loading={false} />
                            </button>
                          ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
              {cashTokenView === 'Contract' && (
                <div>
                  <h5 className="font-semibold mb-2">
                    From Contract Addresses
                  </h5>
                  <div className="space-y-4">
                    {/* Fungible Tokens */}
                    {contractCashTokenUTXOs.filter((u) => !u.token?.nft)
                      .length > 0 && (
                      <div>
                        <h6 className="font-semibold mb-2">Fungible Tokens</h6>
                        {contractCashTokenUTXOs
                          .filter((u) => !u.token?.nft)
                          .map((utxo) => (
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
                              <UTXOCard utxos={[utxo]} loading={false} />
                            </button>
                          ))}
                      </div>
                    )}
                    {/* Non-Fungible Tokens */}
                    {contractCashTokenUTXOs.filter((u) => u.token?.nft).length >
                      0 && (
                      <div>
                        <h6 className="font-semibold mb-2">
                          Non-Fungible Tokens
                        </h6>
                        {contractCashTokenUTXOs
                          .filter((u) => u.token?.nft)
                          .map((utxo) => (
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
                              <UTXOCard utxos={[utxo]} loading={false} />
                            </button>
                          ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </Popup>
        )}
      </div>

      {/* Paper Wallet UTXOs Button and Popup */}
      <div className="mb-4">
        {paperWalletUTXOs.length > 0 && (
          <button
            className="bg-green-500 font-bold text-sm text-white py-2 px-4 rounded mb-2 mr-2"
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
                  <UTXOCard utxos={[utxo]} loading={false} />
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
