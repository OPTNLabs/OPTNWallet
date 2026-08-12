// src/components/transaction/UTXOSelection.tsx

import React, { useState } from 'react';
import { UTXO } from '../../types/types';
import UTXOCard from '../UTXOCard';
import Popup from './Popup';

interface UTXOSelectionProps {
  // selectedAddresses: string[];
  // selectedContractAddresses: string[];
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
  // selectedAddresses,
  // selectedContractAddresses,
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
  // const regularAddresses = selectedAddresses.filter(
  //   (addr) => !selectedContractAddresses.includes(addr)
  // );

  // Split contract UTXOs into regular (non-token) and cash token (token) categories
  const contractRegularUTXOs = filteredContractUTXOs.filter(
    (utxo) => !utxo.token
  );
  const contractCashTokenUTXOs = filteredContractUTXOs.filter(
    (utxo) => utxo.token
  );

  // Reusable component for rendering fungible and non-fungible token sections
  const TokenSection: React.FC<{
    utxos: UTXO[];
    selectedUtxos: UTXO[];
    handleUtxoClick: (utxo: UTXO) => void;
  }> = ({ utxos, selectedUtxos, handleUtxoClick }) => {
    const fungibleUtxos = utxos.filter((u) => !u.token?.nft);
    const nonFungibleUtxos = utxos.filter((u) => u.token?.nft);

    return (
      <div className="space-y-4">
        {fungibleUtxos.length > 0 && (
          <div>
            <h6 className="font-semibold mb-2">Fungible Tokens</h6>
            {fungibleUtxos.map((utxo) => (
              <button
                key={utxo.id}
                onClick={() => handleUtxoClick(utxo)}
                className={`block w-full text-left p-2 mb-2 border rounded-lg break-words whitespace-normal ${
                  selectedUtxos.some(
                    (s) =>
                      s.tx_hash === utxo.tx_hash && s.tx_pos === utxo.tx_pos
                  )
                    ? 'wallet-selectable-active'
                    : 'wallet-selectable-inactive'
                }`}
              >
                <UTXOCard utxos={[utxo]} loading={false} />
              </button>
            ))}
          </div>
        )}
        {nonFungibleUtxos.length > 0 && (
          <div>
            <h6 className="font-semibold mb-2">Non-Fungible Tokens</h6>
            {nonFungibleUtxos.map((utxo) => (
              <button
                key={utxo.id}
                onClick={() => handleUtxoClick(utxo)}
                className={`block w-full text-left p-2 mb-2 border rounded-lg break-words whitespace-normal ${
                  selectedUtxos.some(
                    (s) =>
                      s.tx_hash === utxo.tx_hash && s.tx_pos === utxo.tx_pos
                  )
                    ? 'wallet-selectable-active'
                    : 'wallet-selectable-inactive'
                }`}
              >
                <UTXOCard utxos={[utxo]} loading={false} />
              </button>
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex flex-wrap gap-2 justify-center">
      {/* Regular UTXOs Button and Popup */}
      <div>
        {(filteredRegularUTXOs.length > 0 ||
          contractRegularUTXOs.length > 0) && (
          <button
            className="wallet-btn-primary text-sm font-bold mb-2"
            onClick={() => setShowRegularUTXOsPopup(true)}
          >
            Regular UTXOs
          </button>
        )}
        {showRegularUTXOsPopup && (
          <Popup closePopups={closePopups}>
            {/* <h4 className="text-md font-semibold mb-4">Regular UTXOs</h4> */}
            <div className="flex justify-between mb-4">
              <button
                className={`py-2 px-4 rounded ${
                  regularView === 'Wallet'
                    ? 'wallet-segment-active'
                    : 'wallet-segment-inactive'
                }`}
                onClick={() => setRegularView('Wallet')}
              >
                Wallet
              </button>
              <button
                className={`py-2 px-4 rounded ${
                  regularView === 'Contract'
                    ? 'wallet-segment-active'
                    : 'wallet-segment-inactive'
                }`}
                onClick={() => setRegularView('Contract')}
              >
                Contract
              </button>
            </div>
            <div className="overflow-y-auto max-h-80 space-y-4">
              {regularView === 'Wallet' && (
                <div>
                  <h5 className="font-semibold flex flex-col items-center mb-2">
                    Wallet Address UTXOs
                  </h5>
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
                          ? 'wallet-selectable-active'
                          : 'wallet-selectable-inactive'
                      }`}
                    >
                      <UTXOCard utxos={[utxo]} loading={false} />
                    </button>
                  ))}
                </div>
              )}
              {regularView === 'Contract' && (
                <div>
                  <h5 className="font-semibold flex flex-col items-center mb-2">
                    Contract Address UTXOs
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
                          ? 'wallet-selectable-active'
                          : 'wallet-selectable-inactive'
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
            className="wallet-btn-primary text-sm font-bold mb-2"
            onClick={() => setShowCashTokenUTXOsPopup(true)}
          >
            CashToken UTXOs
          </button>
        )}
        {showCashTokenUTXOsPopup && (
          <Popup closePopups={closePopups}>
            <div className="flex justify-between mb-4">
              <button
                className={`py-2 px-4 rounded ${
                  cashTokenView === 'Wallet'
                    ? 'wallet-segment-active'
                    : 'wallet-segment-inactive'
                }`}
                onClick={() => setCashTokenView('Wallet')}
              >
                Wallet
              </button>
              <button
                className={`py-2 px-4 rounded ${
                  cashTokenView === 'Contract'
                    ? 'wallet-segment-active'
                    : 'wallet-segment-inactive'
                }`}
                onClick={() => setCashTokenView('Contract')}
              >
                Contract
              </button>
            </div>
            <div className="overflow-y-auto max-h-80 space-y-4">
              {cashTokenView === 'Wallet' && (
                <div>
                  <h5 className="font-semibold flex flex-col items-center mb-2">
                    Wallet Address UTXOs
                  </h5>
                  <TokenSection
                    utxos={filteredCashTokenUTXOs}
                    selectedUtxos={selectedUtxos}
                    handleUtxoClick={handleUtxoClick}
                  />
                </div>
              )}
              {cashTokenView === 'Contract' && (
                <div>
                  <h5 className="font-semibold flex flex-col items-center mb-2">
                    Contract Address UTXOs
                  </h5>
                  <TokenSection
                    utxos={contractCashTokenUTXOs}
                    selectedUtxos={selectedUtxos}
                    handleUtxoClick={handleUtxoClick}
                  />
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
            className="wallet-btn-primary font-bold text-sm mb-2 mr-2"
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
                      ? 'wallet-selectable-active'
                      : 'wallet-selectable-inactive'
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
