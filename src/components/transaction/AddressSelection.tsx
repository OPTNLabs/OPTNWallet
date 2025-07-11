// src/components/transaction/AddressSelection.tsx

import React, { useState } from 'react';
import Popup from './Popup';
import { shortenTxHash } from '../../utils/shortenHash';
import { useSelector } from 'react-redux';
import { RootState } from '../../redux/store';
import { selectCurrentNetwork } from '../../redux/selectors/networkSelectors';
import { PREFIX } from '../../utils/constants';
// import { Network } from 'cashscript';

interface AddressSelectionProps {
  addresses: { address: string; tokenAddress: string }[];
  selectedAddresses: string[];
  contractAddresses: {
    address: string;
    tokenAddress: string;
    contractName: string;
    abi: any[];
  }[];
  selectedContractAddresses: string[];
  setSelectedContractAddresses: React.Dispatch<React.SetStateAction<string[]>>;
  selectedContractABIs: any[];
  setSelectedContractABIs: React.Dispatch<React.SetStateAction<any[]>>;
  setSelectedAddresses: React.Dispatch<React.SetStateAction<string[]>>;
}

const AddressSelection: React.FC<AddressSelectionProps> = ({
  addresses,
  selectedAddresses,
  contractAddresses,
  selectedContractAddresses,
  setSelectedContractAddresses,
  selectedContractABIs,
  setSelectedContractABIs,
  setSelectedAddresses,
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
  const toggleContractSelection = (address: string, abi: any) => {
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
      {/* Wallet Addresses Button */}
      <button
        className="bg-blue-500 font-bold text-white py-2 px-4 rounded flex-1"
        onClick={() => setShowWalletAddressesPopup(true)}
      >
        Wallet
      </button>

      {/* Contracts Addresses Button */}
      <button
        className="bg-blue-500 font-bold text-white py-2 px-4 rounded flex-1"
        onClick={() => setShowContractAddressesPopup(true)}
      >
        Contracts
      </button>

      {/* Popup for Wallet Addresses */}
      {showWalletAddressesPopup && (
        <Popup closePopups={closePopups}>
          <h4 className="text-md font-semibold mb-4">Wallet Addresses</h4>
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
                      isSelected ? 'bg-blue-100' : 'bg-white border-gray-300'
                    }`}
                    aria-pressed={isSelected}
                  >
                    <div className="flex flex-col">
                      <span className="font-medium">
                        Address:{' '}
                        {shortenTxHash(
                          addressObj.address,
                          PREFIX[currentNetwork].length
                        )}
                      </span>
                      <span className="text-sm text-gray-600">
                        Token Address:{' '}
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

      {/* Popup for Contract Addresses */}
      {showContractAddressesPopup && (
        <Popup closePopups={closePopups}>
          <h4 className="text-md font-semibold mb-4">Contract Addresses</h4>
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
                      isSelected ? 'bg-blue-100 ' : 'bg-white border-gray-300'
                    }`}
                    aria-pressed={isSelected}
                  >
                    <div className="flex flex-col">
                      <span className="font-medium">
                        Contract Name: {contractObj.contractName}
                      </span>
                      <span className="text-sm text-gray-600">
                        Contract Address:{' '}
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
