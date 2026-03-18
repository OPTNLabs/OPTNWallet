// src/components/transaction/AddressSelection.tsx

import React, { useState } from 'react';
import Popup from './Popup';
import { shortenTxHash } from '../../utils/shortenHash';
import { useSelector } from 'react-redux';
import { RootState } from '../../redux/store';
import { selectCurrentNetwork } from '../../redux/selectors/networkSelectors';
import { PREFIX } from '../../utils/constants';
import { UTXO } from '../../types/types';
import SweepPaperWallet from '../SweepPaperWallet';
// import { Network } from 'cashscript';

interface AddressSelectionProps {
  addresses: { address: string; tokenAddress: string }[];
  selectedUtxos: UTXO[];
  selectedAddresses: string[];
  contractAddresses: {
    address: string;
    tokenAddress: string;
    contractName: string;
    abi: unknown[];
  }[];
  selectedContractAddresses: string[];
  setSelectedContractAddresses: React.Dispatch<React.SetStateAction<string[]>>;
  selectedContractABIs: unknown[];
  setSelectedContractABIs: React.Dispatch<React.SetStateAction<unknown[]>>;
  setSelectedAddresses: React.Dispatch<React.SetStateAction<string[]>>;
  setPaperWalletUTXOs: React.Dispatch<React.SetStateAction<UTXO[]>>;
}
//SweepPaperWallet
const AddressSelection: React.FC<AddressSelectionProps> = ({
  addresses,
  selectedUtxos,
  selectedAddresses,
  contractAddresses,
  selectedContractAddresses,
  setSelectedContractAddresses,
  selectedContractABIs,
  setSelectedContractABIs,
  setSelectedAddresses,
  setPaperWalletUTXOs,
}) => {
  const [showWalletAddressesPopup, setShowWalletAddressesPopup] =
    useState(false); // State for wallet addresses popup
  const [showContractAddressesPopup, setShowContractAddressesPopup] =
    useState(false);

  const currentNetwork = useSelector((state: RootState) =>
    selectCurrentNetwork(state)
  );

  // Toggle selection for regular wallet addresses
  const toggleAddressSelection = (address: string) => {
    if (selectedAddresses.includes(address)) {
      setSelectedAddresses(
        selectedAddresses.filter(
          (selectedAddress) => selectedAddress !== address
        )
      );
    } else {
      setSelectedAddresses([...selectedAddresses, address]);
    }
  };

  // Toggle selection for contract addresses
  const toggleContractSelection = (address: string, abi: unknown[]) => {
    const isSelected =
      selectedContractAddresses.includes(address) &&
      selectedContractABIs.some(
        (existingAbi) => JSON.stringify(existingAbi) === JSON.stringify(abi)
      );

    if (isSelected) {
      setSelectedContractAddresses(
        selectedContractAddresses.filter(
          (selectedContractAddress) => selectedContractAddress !== address
        )
      );
      setSelectedContractABIs(
        selectedContractABIs.filter(
          (existingAbi) => JSON.stringify(existingAbi) !== JSON.stringify(abi)
        )
      );
    } else {
      setSelectedContractAddresses([...selectedContractAddresses, address]);
      setSelectedContractABIs([...selectedContractABIs, abi]);
    }
  };

  const closePopups = () => {
    setShowWalletAddressesPopup(false);
    setShowContractAddressesPopup(false);
  };

  return (
    <div className="flex flex-wrap gap-2">
      <button
        className="wallet-btn-primary flex-1"
        onClick={() => setShowWalletAddressesPopup(true)}
      >
        Wallet funds
      </button>

      <button
        className="wallet-btn-primary flex-1"
        onClick={() => setShowContractAddressesPopup(true)}
      >
        Contracts
      </button>

      <SweepPaperWallet setPaperWalletUTXOs={setPaperWalletUTXOs} />

      {selectedAddresses.length === 0 &&
        selectedContractAddresses.length === 0 &&
        selectedUtxos.length === 0 && (
          <div className="text-sm wallet-muted">
            Select a source to continue.
          </div>
        )}

      {showWalletAddressesPopup && (
        <Popup closePopups={closePopups}>
          <h4 className="text-md font-semibold text-center mb-4">
            Wallet sources
          </h4>
          <div className="overflow-y-auto max-h-80">
            {addresses.length === 0 ? (
              <p>No wallet addresses available.</p>
            ) : (
              addresses.map((addressObj) => {
                const isSelected = selectedAddresses.includes(
                  addressObj.address
                );

                return (
                  <button
                    key={addressObj.address}
                    onClick={() => toggleAddressSelection(addressObj.address)}
                    className={`w-full text-left p-2 mb-2 border rounded-lg break-words whitespace-normal focus:outline-none ${
                      isSelected
                        ? 'wallet-selectable-active'
                        : 'wallet-selectable-inactive'
                    }`}
                    aria-pressed={isSelected}
                  >
                    <div className="flex flex-col">
                      <span className="font-medium">
                        BCH address:{' '}
                        {shortenTxHash(
                          addressObj.address,
                          PREFIX[currentNetwork].length
                        )}
                      </span>
                      <span className="text-sm wallet-muted">
                        Token address:{' '}
                        {shortenTxHash(
                          addressObj.tokenAddress,
                          PREFIX[currentNetwork].length
                        )}
                      </span>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </Popup>
      )}

      {showContractAddressesPopup && (
        <Popup closePopups={closePopups}>
          <h4 className="text-md font-semibold text-center mb-4">
            Contract sources
          </h4>
          <div className="overflow-y-auto max-h-80">
            {contractAddresses.length === 0 ? (
              <p>No contract addresses available.</p>
            ) : (
              contractAddresses.map((contractObj) => {
                const isSelected =
                  selectedContractAddresses.includes(contractObj.address) &&
                  selectedContractABIs.some(
                    (existingAbi) =>
                      JSON.stringify(existingAbi) ===
                      JSON.stringify(contractObj.abi)
                  );

                return (
                  <button
                    key={contractObj.address}
                    onClick={() =>
                      toggleContractSelection(
                        contractObj.address,
                        contractObj.abi
                      )
                    }
                    className={`w-full text-left p-2 mb-2 border rounded-lg break-words whitespace-normal focus:outline-none ${
                      isSelected
                        ? 'wallet-selectable-active'
                        : 'wallet-selectable-inactive'
                    }`}
                    aria-pressed={isSelected}
                  >
                    <div className="flex flex-col">
                      <span className="font-medium">
                        {contractObj.contractName}
                      </span>
                      <span className="text-sm wallet-muted">
                        Contract address:{' '}
                        {shortenTxHash(
                          contractObj.address,
                          PREFIX[currentNetwork].length
                        )}
                      </span>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </Popup>
      )}
    </div>
  );
};

export default AddressSelection;
