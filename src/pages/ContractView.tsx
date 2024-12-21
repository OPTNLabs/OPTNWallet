// src/pages/ContractView.tsx

import React, { useState, useEffect } from 'react';
import { useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import { TailSpin } from 'react-loader-spinner';
import ContractManager from '../apis/ContractManager/ContractManager';
import { hexString } from '../utils/hex';
import { RootState } from '../redux/store';
import parseInputValue from '../utils/parseInputValue';
import AddressSelectionPopup from '../components/AddressSelectionPopup';
import KeyService from '../services/KeyService';
import { shortenTxHash } from '../utils/shortenHash';
import { PREFIX } from '../utils/constants';
import { Toast } from '@capacitor/toast';
import Popup from '../components/transaction/Popup';

// Import Barcode Scanner
import {
  CapacitorBarcodeScanner,
  CapacitorBarcodeScannerTypeHint,
} from '@capacitor/barcode-scanner';
import { FaCamera } from 'react-icons/fa'; // Optional: If you want to use an icon for the scan button

// type QRCodeType = 'address' | 'pubKey' | 'pkh';

const ContractView = () => {
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [availableContracts, setAvailableContracts] = useState<any[]>([]);
  const [selectedContractFile, setSelectedContractFile] = useState<string>('');
  const [constructorArgs, setConstructorArgs] = useState<any[]>([]);
  const [inputValues, setInputValues] = useState<{ [key: string]: any }>({});
  const [contractInstances, setContractInstances] = useState<any[]>([]);
  const [showAddressPopup, setShowAddressPopup] = useState<boolean>(false);
  const [currentArgName, setCurrentArgName] = useState<string>('');
  const [showConstructorArgsPopup, setShowConstructorArgsPopup] =
    useState<boolean>(false); // State for constructor args popup
  const [showErrorPopup, setShowErrorPopup] = useState<boolean>(false); // New state for error popup
  const [errorMessage, setErrorMessage] = useState<string>(''); // Error message content
  const [isScanning, setIsScanning] = useState<boolean>(false);

  const navigate = useNavigate();
  const wallet_id = useSelector(
    (state: RootState) => state.wallet_id.currentWalletId
  );
  const currentNetwork = useSelector(
    (state: RootState) => state.network.currentNetwork
  );

  useEffect(() => {
    const loadAvailableContracts = async () => {
      try {
        const contractManager = ContractManager();
        const contracts = contractManager.listAvailableArtifacts();
        if (!contracts || contracts.length === 0) {
          throw new Error('No available contracts found');
        }
        setAvailableContracts(contracts);
      } catch (err: any) {
        console.error('Error loading available contracts:', err);
        setError(err.message);
      }
    };

    const loadContractInstances = async () => {
      try {
        const contractManager = ContractManager();
        const instances = await contractManager.fetchContractInstances();
        setContractInstances(instances);
      } catch (err: any) {
        console.error('Error loading contract instances:', err);
        setError(err.message);
      }
    };

    loadAvailableContracts();
    loadContractInstances();
  }, []);

  useEffect(() => {
    const loadContractDetails = async () => {
      if (selectedContractFile) {
        try {
          const contractManager = ContractManager();
          const artifact = contractManager.loadArtifact(selectedContractFile);
          if (!artifact) {
            throw new Error(
              `Artifact ${selectedContractFile} could not be loaded`
            );
          }
          setConstructorArgs(artifact.constructorInputs || []);
          setShowConstructorArgsPopup(true); // Open the constructor args popup
        } catch (err: any) {
          console.error('Error loading contract details:', err);
          setError(err.message);
        }
      }
    };

    loadContractDetails();
  }, [selectedContractFile]);

  const handleInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = event.target;
    setInputValues({ ...inputValues, [name]: value });
    // Optional: Debugging
    console.log(`Input changed: ${name} = ${value}`);
  };

  const handleCopyAddress = async (address: string) => {
    try {
      await navigator.clipboard.writeText(address);
      await Toast.show({
        text: 'Address copied to clipboard!',
      });
    } catch (error) {
      console.error('Failed to copy address:', error);
      await Toast.show({
        text: 'Failed to copy address.',
      });
    }
  };

  const handleAddressSelect = async (address: string) => {
    // console.log(`Address selected for ${currentArgName}: ${address}`);

    const keys = await KeyService.retrieveKeys(wallet_id);
    const selectedKey = keys.find((key) => key.address === address);

    if (selectedKey) {
      const matchedArg = constructorArgs.find(
        (arg) => arg.name === currentArgName
      );

      if (matchedArg) {
        let valueToSet = '';
        if (matchedArg.type === 'pubkey') {
          valueToSet = hexString(selectedKey.publicKey);
        } else if (matchedArg.type === 'bytes20') {
          valueToSet = hexString(selectedKey.pubkeyHash);
        }

        setInputValues({ ...inputValues, [currentArgName]: valueToSet });

        // Optional: Debugging
        console.log(`Set inputValues for ${currentArgName}: ${valueToSet}`);
      }
    }
    setShowAddressPopup(false);
    setCurrentArgName('');
  };

  const scanBarcode = async (argName: string) => {
    if (isScanning) {
      // Prevent multiple scans at the same time
      return;
    }

    setIsScanning(true); // Start scanning

    try {
      // Initiate barcode scanning with desired options
      const result = await CapacitorBarcodeScanner.scanBarcode({
        hint: CapacitorBarcodeScannerTypeHint.ALL,
        cameraDirection: 1, // Use BACK camera; change if needed
      });

      // If a scan result is obtained, set it as the input value
      if (result && result.ScanResult) {
        // Optionally, validate the scan result based on the expected type
        // For simplicity, assume the QR code contains the required value directly
        setInputValues((prev) => ({
          ...prev,
          [argName]: result.ScanResult,
        }));
        // await Toast.show({
        //   text: `Scanned: ${result.ScanResult}`,
        // });

        // Optional: Debugging
        console.log(`Scanned value for ${argName}: ${result.ScanResult}`);
      } else {
        await Toast.show({
          text: 'No QR code detected. Please try again.',
        });
      }
    } catch (error) {
      console.error('Barcode scan error:', error);
      await Toast.show({
        text: 'Failed to scan QR code. Please ensure camera permissions are granted and try again.',
      });
    } finally {
      setIsScanning(false); // End scanning
    }
  };

  const validateConstructorArgs = (): boolean => {
    for (const arg of constructorArgs) {
      if (
        inputValues[arg.name] === undefined ||
        inputValues[arg.name] === null ||
        inputValues[arg.name].toString().trim() === ''
      ) {
        setErrorMessage(
          `Please provide a value for "${arg.name}" (${arg.type}).`
        );
        setShowErrorPopup(true);
        return false;
      }
    }
    return true;
  };

  const createContract = async () => {
    // Validate constructor arguments
    if (!validateConstructorArgs()) {
      return;
    }

    setIsLoading(true); // Start loading

    try {
      const contractManager = ContractManager();
      const args =
        constructorArgs.map((arg) =>
          parseInputValue(inputValues[arg.name], arg.type)
        ) || [];

      if (
        constructorArgs.length > 0 &&
        args.length !== constructorArgs.length
      ) {
        throw new Error('All constructor arguments must be provided');
      }

      await contractManager.createContract(
        selectedContractFile,
        args,
        currentNetwork
      );

      const instances = await contractManager.fetchContractInstances();
      setContractInstances(instances);
      setSelectedContractFile('');
      setConstructorArgs([]);
      setInputValues({});
      setShowConstructorArgsPopup(false); // Close the popup after creation

      await Toast.show({
        text: 'Contract created successfully!',
      });
    } catch (err: any) {
      console.error('Error creating contract:', err);
      setErrorMessage(`Failed to create contract: ${err.message}`);
      setShowErrorPopup(true); // Show error popup
    } finally {
      setIsLoading(false); // Stop loading
    }
  };

  const deleteContract = async (contractId: string) => {
    try {
      const contractManager = ContractManager();
      await contractManager.deleteContractInstance(parseInt(contractId));

      const instances = await contractManager.fetchContractInstances();
      setContractInstances(instances);

      await Toast.show({
        text: 'Contract deleted successfully!',
      });
    } catch (err: any) {
      console.error('Error deleting contract:', err);
      setError(err.message);
      await Toast.show({
        text: 'Failed to delete contract.',
      });
    }
  };

  // Update a contract instance's UTXOs and balance
  const updateContract = async (address: string) => {
    try {
      const contractManager = ContractManager();
      const { added, removed } =
        await contractManager.updateContractUTXOs(address);

      console.log(`UTXOs updated. Added: ${added}, Removed: ${removed}`);

      // Fetch updated contract instance from the database
      const updatedContractInstance =
        await contractManager.getContractInstanceByAddress(address);

      // Calculate the total balance by summing all the UTXO amounts
      const totalBalance = updatedContractInstance.utxos.reduce(
        (sum: bigint, utxo: any) => {
          return sum + BigInt(utxo.amount);
        },
        BigInt(0)
      );

      // Update the state with the new UTXOs and calculated balance
      setContractInstances((prevInstances) =>
        prevInstances.map((instance) =>
          instance.address === address
            ? {
                ...instance,
                balance: totalBalance, // Set calculated balance
                utxos: updatedContractInstance.utxos, // Update UTXOs
              }
            : instance
        )
      );

      await Toast.show({
        text: 'Contract updated successfully!',
      });
    } catch (err: any) {
      console.error('Error updating UTXOs and balance:', err);
      setError(err.message);
      await Toast.show({
        text: 'Failed to update contract.',
      });
    }
  };

  const handleErrorPopupClose = () => {
    setShowErrorPopup(false);
    setErrorMessage('');
  };

  if (error) {
    return <div>Error: {error}</div>;
  }

  const returnHome = () => {
    navigate(`/home/${wallet_id}`);
  };

  return (
    <div className="container mx-auto p-4">
      <div className="flex justify-center mt-4">
        <img
          src="/assets/images/OPTNWelcome1.png"
          alt="Welcome"
          className="max-w-full h-auto"
        />
      </div>

      <h2 className="text-lg font-semibold mb-2">Select Contract</h2>
      <select
        className="border p-2 mb-4 w-full"
        value={selectedContractFile}
        onChange={(e) => setSelectedContractFile(e.target.value)}
      >
        <option value="">Select a contract</option>
        {availableContracts.map((contract, index) => (
          <option key={index} value={contract.fileName}>
            {contract.contractName}
          </option>
        ))}
      </select>

      {/* Render the Constructor Arguments inside a Popup */}
      {showConstructorArgsPopup && (
        <Popup
          closePopups={() => {
            setShowConstructorArgsPopup(false);
            setSelectedContractFile('');
            setConstructorArgs([]);
            setInputValues({});
            setCurrentArgName('');
          }}
        >
          <h2 className="text-lg font-semibold mb-2">Constructor Arguments</h2>
          {constructorArgs.map((arg, index) => {
            const isAddressType =
              arg.type === 'bytes20' || arg.type === 'pubkey';

            return (
              <div key={index} className="mb-4">
                <label className="block text-sm font-medium text-gray-700">
                  {arg.name} ({arg.type})
                </label>
                {isAddressType ? (
                  <>
                    <div className="flex items-center">
                      <button
                        type="button"
                        onClick={() => {
                          setCurrentArgName(arg.name);
                          setShowAddressPopup(true);
                        }}
                        className="bg-blue-500 hover:bg-blue-600 transition duration-300 font-bold text-white py-2 px-4 rounded mr-2"
                        disabled={isScanning} // Disable button during scan
                        aria-label={`Select Address for ${arg.name}`}
                      >
                        Select Address
                      </button>
                      <button
                        type="button"
                        onClick={() => scanBarcode(arg.name)} // Pass arg.name directly
                        className={`bg-green-500 hover:bg-green-600 transition duration-300 text-white py-2 px-4 rounded ${
                          isScanning ? 'opacity-50 cursor-not-allowed' : ''
                        }`}
                        disabled={isScanning}
                        aria-label={`Scan QR Code for ${arg.name}`}
                      >
                        <FaCamera /> {/* Optional: Camera icon */}
                      </button>
                    </div>
                    {inputValues[arg.name] && (
                      <div className="mt-2">
                        Selected {arg.type}:{' '}
                        {shortenTxHash(
                          inputValues[arg.name],
                          PREFIX[currentNetwork].length
                        )}
                      </div>
                    )}
                  </>
                ) : (
                  <input
                    type="text"
                    name={arg.name}
                    value={inputValues[arg.name] || ''}
                    onChange={handleInputChange}
                    className="border p-2 w-full rounded-md"
                    placeholder={`Enter ${arg.name}`}
                  />
                )}
              </div>
            );
          })}

          <button
            onClick={createContract}
            className={`bg-blue-500 hover:bg-blue-600 transition duration-300  text-white py-2 px-4 rounded mb-4 flex items-center justify-center ${
              isLoading ? 'cursor-not-allowed opacity-50' : ''
            }`}
            disabled={isLoading} // Disable the button while loading
          >
            {isLoading ? (
              <TailSpin
                visible={true}
                height="24"
                width="24"
                color="white" // Match the spinner color with the button text color
                ariaLabel="tail-spin-loading"
                radius="1"
              />
            ) : (
              <div className="font-bold">Create Contract</div>
            )}
          </button>
        </Popup>
      )}

      {contractInstances.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold mb-2">Instantiated Contracts</h2>
          <div className="overflow-y-auto max-h-80 mb-4">
            <ul>
              {contractInstances.map((instance) => (
                <li
                  key={instance.id}
                  className="mb-4 p-4 border rounded bg-gray-100"
                >
                  <div>
                    <div className="mb-2 overflow-x-auto">
                      <strong>Contract Name:</strong> {instance.contract_name}
                    </div>
                    <div
                      className="mb-2 cursor-pointer"
                      onClick={() => handleCopyAddress(instance.address)}
                    >
                      <strong>Address:</strong>{' '}
                      {shortenTxHash(
                        instance.address,
                        PREFIX[currentNetwork].length
                      )}
                    </div>
                    <div
                      className="mb-2 cursor-pointer"
                      onClick={() => handleCopyAddress(instance.token_address)}
                    >
                      <strong>Token Address:</strong>{' '}
                      {shortenTxHash(
                        instance.token_address,
                        PREFIX[currentNetwork].length
                      )}
                    </div>
                    {/* Additional Contract Details (Optional) */}
                    {/* 
                    <div className="mb-2">
                      <strong>Opcount:</strong> {instance.opcount}
                    </div>
                    <div className="mb-2">
                      <strong>Bytesize:</strong> {instance.bytesize}
                    </div>
                    <div className="mb-2">
                      <strong>Bytecode:</strong>{' '}
                      {shortenTxHash(instance.bytecode)}
                    </div> 
                    */}
                    <div className="mb-2">
                      <strong>Balance:</strong> {instance.balance.toString()}{' '}
                      satoshis
                    </div>
                  </div>

                  {/* Additional Contract Information (Optional) */}
                  {/* 
                  <div className="mb-2">
                    <strong>UTXOs:</strong>
                    <RegularUTXOs
                      utxos={instance.utxos
                        .filter((utxo) => !utxo.token) // Filter out stale UTXOs
                        .map((utxo) => ({
                          ...utxo,
                          amount: utxo.amount.toString(),
                          tx_hash: utxo.tx_hash,
                          tx_pos: utxo.tx_pos,
                        }))}
                      loading={false}
                    />
                    <CashTokenUTXOs
                      utxos={instance.utxos
                        .filter((utxo) => utxo.token)
                        .map((utxo) => ({
                          ...utxo,
                          amount: utxo.amount.toString(),
                          tx_hash: utxo.tx_hash,
                          tx_pos: utxo.tx_pos,
                          token_data: {
                            amount: utxo.token.amount,
                            category: utxo.token.category,
                          },
                        }))}
                      loading={false}
                    />
                  </div> 
                  */}
                  <button
                    onClick={() => updateContract(instance.address)}
                    className="bg-green-500 hover:bg-green-600 font-bold text-white py-2 px-4 my-2 rounded"
                  >
                    Update
                  </button>
                  <button
                    onClick={() => deleteContract(instance.id)}
                    className="bg-red-500 hover:bg-red-600 font-bold text-white py-2 px-4 my-2 rounded"
                  >
                    Delete
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <button
        onClick={returnHome}
        className="w-full bg-red-500 font-bold text-white py-2 px-4 rounded-md hover:bg-red-600 transition duration-300 my-2"
      >
        Go Back
      </button>

      {/* Address Selection Popup */}
      {showAddressPopup && (
        <AddressSelectionPopup
          onSelect={handleAddressSelect}
          onClose={() => {
            setShowAddressPopup(false);
            setCurrentArgName('');
          }}
        />
      )}

      {/* Error Popup */}
      {showErrorPopup && (
        <Popup closePopups={handleErrorPopupClose}>
          <h2 className="text-lg font-semibold mb-2">Error</h2>
          <p className="mb-4">{errorMessage}</p>
          <button
            onClick={handleErrorPopupClose}
            className="mt-4 bg-red-500 font-bold text-white py-2 px-4 rounded"
          >
            Close
          </button>
        </Popup>
      )}
    </div>
  );
};

export default ContractView;
