// src/components/transaction/AddressSelection.tsx

import React, { useState } from 'react';
import Popup from './Popup';

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

  console.log('AddressSelection Props:', {
    addresses,
    selectedAddresses,
    contractAddresses,
    selectedContractAddresses,
    selectedContractABIs,
  });

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
    <div className="mb-6">
      <h3 className="text-lg font-semibold mb-2">
        Select Addresses to Spend From
      </h3>
      {/* Wallet Addresses Button */}
      <button
        className="bg-blue-500 text-white mx-1 py-2 px-4 rounded mb-2"
        onClick={() => setShowWalletAddressesPopup(true)}
      >
        Wallet Addresses
      </button>
      {showWalletAddressesPopup && (
        <Popup closePopups={closePopups}>
          <h4 className="text-md font-semibold mb-4">Wallet Addresses</h4>
          <div className="overflow-y-auto max-h-80">
            {addresses.length === 0 ? (
              <p>No wallet addresses available.</p>
            ) : (
              addresses.map((addressObj) => (
                <div
                  key={addressObj.address}
                  className="flex items-center mb-2 break-words whitespace-normal"
                >
                  <input
                    type="checkbox"
                    checked={selectedAddresses.includes(addressObj.address)}
                    onChange={() => toggleAddressSelection(addressObj.address)}
                    className="mr-2"
                  />
                  <span className="break-words overflow-x-auto">
                    {`Address: ${addressObj.address}`}
                    <br />
                    {`Token Address: ${addressObj.tokenAddress}`}
                  </span>
                </div>
              ))
            )}
          </div>
        </Popup>
      )}
      {/* Contract Addresses Button */}
      <button
        className="bg-blue-500 text-white mx-1 py-2 px-4 rounded mb-2"
        onClick={() => setShowContractAddressesPopup(true)}
      >
        Contract Addresses
      </button>
      {showContractAddressesPopup && (
        <Popup closePopups={closePopups}>
          <h4 className="text-md font-semibold mb-4">Contract Addresses</h4>
          <div className="overflow-y-auto max-h-80">
            {contractAddresses.length === 0 ? (
              <p>No contract addresses available.</p>
            ) : (
              contractAddresses.map((contractObj) => (
                <div
                  key={contractObj.address}
                  className="flex items-center mb-2 break-words whitespace-normal"
                >
                  <input
                    type="checkbox"
                    checked={selectedContractAddresses.includes(
                      contractObj.address
                    )}
                    onChange={() => {
                      toggleAddressSelection(contractObj.address);
                      toggleContractSelection(
                        contractObj.address,
                        contractObj.abi
                      );
                    }}
                    className="mr-2"
                  />
                  <span className="break-words overflow-x-auto">
                    {`Contract Address: ${contractObj.address}`}
                    <br />
                    {`Token Address: ${contractObj.tokenAddress}`}
                  </span>
                </div>
              ))
            )}
          </div>
        </Popup>
      )}
    </div>
  );
};

export default AddressSelection;
