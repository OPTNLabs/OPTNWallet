import { useState } from 'react';
import Popup from './Popup';

function AddressSelection({
  addresses,
  selectedAddresses,
  contractAddresses,
  selectedContractAddresses,
  setSelectedContractAddresses,
  selectedContractABIs,
  setSelectedContractABIs,
  setSelectedAddresses,
}) {
  const [showWalletAddressesPopup, setShowWalletAddressesPopup] =
    useState(false); // State for wallet addresses popup
  const [showContractAddressesPopup, setShowContractAddressesPopup] =
    useState(false);

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
  const toggleContractSelection = (address: string, abi: {}) => {
    if (
      selectedContractAddresses.includes(address) &&
      selectedContractABIs.includes(abi)
    ) {
      setSelectedContractAddresses(
        selectedContractAddresses.filter(
          (selectedContractAddress) => selectedContractAddress !== address
        )
      );
      setSelectedContractABIs(
        selectedContractABIs.filter(
          (selectedContractABI) => selectedContractABI !== abi
        )
      );
    } else {
      setSelectedContractAddresses([...selectedContractAddresses, address]);
      setSelectedContractABIs([...selectedContractABIs, abi]);
    }
  };
  function closePopups() {
    setShowWalletAddressesPopup(false);
    setShowContractAddressesPopup(false);
  }
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
            {addresses.map((addressObj) => (
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
            ))}
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
            {contractAddresses.map((contractObj) => (
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
            ))}
          </div>
        </Popup>
      )}
    </div>
  );
}

export default AddressSelection;
