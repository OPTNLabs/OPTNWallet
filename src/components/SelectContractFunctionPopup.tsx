// src/components/SelectContractFunctionPopup.tsx

import React, { useState, useEffect } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import AddressSelectionPopup from './AddressSelectionPopup';
import {
  setSelectedFunction,
  setInputs,
  setInputValues,
} from '../redux/contractSlice'; // Importing actions from contractSlice
import { encodePrivateKeyWif } from '@bitauth/libauth';
import { RootState, AppDispatch } from '../redux/store';
import { hexString, hexToUint8Array } from '../utils/hex';
import KeyService from '../services/KeyService';
import { shortenTxHash } from '../utils/shortenHash';
import {
  CapacitorBarcodeScanner,
  CapacitorBarcodeScannerTypeHint,
} from '@capacitor/barcode-scanner';
import { FaCamera } from 'react-icons/fa'; // Optional: If you want to use an icon for the scan button
import { Toast } from '@capacitor/toast';
// import { PREFIX } from '../utils/constants';

interface AbiInput {
  name: string;
  type: string;
}

interface SelectContractFunctionPopupProps {
  contractABI: any[];
  onClose: () => void;
  onFunctionSelect: (
    selectedFunction: string,
    inputValues: { [key: string]: string }
  ) => void;
}

const SelectContractFunctionPopup: React.FC<
  SelectContractFunctionPopupProps
> = ({ contractABI, onClose, onFunctionSelect }) => {
  const [functions, setFunctions] = useState<any[]>([]);
  const [selectedFunction, setSelectedFunctionState] = useState<string>('');
  const [inputs, setInputsState] = useState<AbiInput[]>([]);
  const [inputValuesState, setInputValuesState] = useState<{
    [key: string]: string;
  }>({});
  const [showAddressPopup, setShowAddressPopup] = useState<boolean>(false);
  const [selectedInput, setSelectedInput] = useState<AbiInput | null>(null);
  const [isScanning, setIsScanning] = useState<boolean>(false);

  const dispatch: AppDispatch = useDispatch();

  // Get the current walletId from the Redux store
  const walletId = useSelector(
    (state: RootState) => state.wallet_id.currentWalletId
  );

  // Synchronize local inputValuesState with Redux's inputValues
  useEffect(() => {
    dispatch(setInputValues(inputValuesState));
  }, [inputValuesState, dispatch]);

  // Fetch the ABI functions
  useEffect(() => {
    if (!contractABI || !Array.isArray(contractABI)) {
      console.error('Contract ABI is invalid or not an array');
      return;
    }

    const allFunctionNames = contractABI
      .filter((item) => item.type === 'function' || item.type === undefined)
      .map((item) => ({ name: item.name, inputs: item.inputs }))
      .filter(
        (item, index, self) =>
          self.findIndex((f) => f.name === item.name) === index
      );

    setFunctions(allFunctionNames);
  }, [contractABI]);

  const handleFunctionSelect = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const selectedFunctionName = e.target.value;
    setSelectedFunctionState(selectedFunctionName);

    const functionAbi = functions.find(
      (item) => item.name === selectedFunctionName
    );
    setInputsState(functionAbi?.inputs || []);
    setInputValuesState({}); // Reset input values when function changes
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setInputValuesState((prev) => ({ ...prev, [name]: value }));
    // Dispatch is handled by useEffect
  };

  const handleAddressSelect = async (address: string) => {
    // Fetch and set the appropriate input value based on the selected input's type
    try {
      if (!selectedInput) return;

      const keys = await KeyService.retrieveKeys(walletId);
      const selectedKey = keys.find((key) => key.address === address);

      if (selectedKey) {
        let valueToSet = '';
        if (selectedInput.type === 'pubkey') {
          valueToSet = hexString(selectedKey.publicKey);
        } else if (selectedInput.type === 'bytes20') {
          valueToSet = hexString(selectedKey.pubkeyHash);
        } else if (selectedInput.type === 'sig') {
          // const privateKeyBytes = hexString(selectedKey.privateKey);
          valueToSet = encodePrivateKeyWif(selectedKey.privateKey, 'testnet'); // Adjust network as needed
        }

        setInputValuesState((prev) => ({
          ...prev,
          [selectedInput.name]: valueToSet,
        }));

        await Toast.show({
          text: `Set ${selectedInput.name}: ${valueToSet}`,
        });
      } else {
        console.error(`No keys found for address: ${address}`);
        await Toast.show({
          text: `No keys found for address: ${address}`,
        });
      }
    } catch (error) {
      console.error('Error fetching keys:', error);
      await Toast.show({
        text: 'Failed to fetch keys.',
      });
    }

    setShowAddressPopup(false);
    setSelectedInput(null);
  };

  const scanBarcode = async (argName: string, argType: string) => {
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
        const scannedValue = result.ScanResult.trim();

        // Validate the scan result based on the expected type
        const isValidHex = (str: string) => /^[0-9a-fA-F]+$/.test(str);

        if (argType === 'sig') {
          if (!isValidHex(scannedValue)) {
            await Toast.show({
              text: `Invalid ${argType} format. Please scan a valid QR code.`,
            });
          } else {
            try {
              // Convert hex string to Uint8Array
              // Encode to WIF
              const wif = encodePrivateKeyWif(
                hexToUint8Array(scannedValue),
                'testnet'
              ); // Adjust network as needed

              setInputValuesState((prev) => ({
                ...prev,
                [argName]: wif,
              }));

              await Toast.show({
                text: `Scanned and set ${argName}: ${wif}`,
              });
            } catch (error) {
              console.error('Failed to encode private key to WIF:', error);
              await Toast.show({
                text: `Failed to process ${argName}.`,
              });
            }
          }
        } else if (argType === 'pubkey' || argType === 'bytes20') {
          if (!isValidHex(scannedValue)) {
            await Toast.show({
              text: `Invalid ${argType} format. Please scan a valid QR code.`,
            });
          } else {
            setInputValuesState((prev) => ({
              ...prev,
              [argName]: scannedValue,
            }));
            await Toast.show({
              text: `Scanned and set ${argName}: ${scannedValue}`,
            });
          }
        } else {
          // Handle other types if necessary
          setInputValuesState((prev) => ({
            ...prev,
            [argName]: scannedValue,
          }));
          await Toast.show({
            text: `Scanned and set ${argName}: ${scannedValue}`,
          });
        }
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
      setShowAddressPopup(false);
      setSelectedInput(null);
      setIsScanning(false); // End scanning
    }
  };

  const handleSelect = () => {
    // Prepare the input values object
    const inputValuesObject = inputs.reduce<{ [key: string]: string }>(
      (acc, input) => {
        acc[input.name] = inputValuesState[input.name] || '';
        return acc;
      },
      {}
    );

    try {
      dispatch(setSelectedFunction(selectedFunction)); // Dispatch the selected function
      dispatch(setInputs(inputs)); // Dispatch the inputs (ABI details)
      // No need to dispatch setInputValues here; it's handled by useEffect

      onFunctionSelect(selectedFunction, inputValuesObject); // Pass the data to the parent component

      onClose(); // Close the popup
    } catch (error) {
      console.error('Error occurred during dispatch or handling:', error);
    }
  };

  const openAddressPopup = (input: AbiInput) => {
    setSelectedInput(input); // Set the entire AbiInput, so we can access both name and type
    setShowAddressPopup(true);
  };

  return (
    <div className="fixed inset-0 bg-gray-500 bg-opacity-75 flex items-center justify-center z-50">
      <div className="bg-white p-6 rounded shadow-lg w-96 max-h-screen overflow-y-auto">
        <h2 className="text-xl font-semibold mb-4">Select a Function</h2>
        <select
          className="border p-2 w-full mb-4 rounded-md"
          value={selectedFunction}
          onChange={handleFunctionSelect}
        >
          <option value="">Select a function</option>
          {functions.map((func, index) => (
            <option key={index} value={func.name}>
              {func.name}
            </option>
          ))}
        </select>
        <div className="mb-4">
          {Array.isArray(inputs) &&
            inputs.map((input, index) => {
              const isAddressType =
                input.type === 'sig' || input.type === 'pubkey';

              return (
                <div key={index} className="mb-4">
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {input.name} ({input.type})
                  </label>
                  {isAddressType ? (
                    <>
                      <div className="flex items-center">
                        <button
                          type="button"
                          onClick={() => openAddressPopup(input)}
                          className="bg-blue-500 text-white py-2 px-4 rounded mr-2 flex-1"
                          disabled={isScanning} // Disable button during scan
                          aria-label={`Select Address for ${input.name}`}
                        >
                          Select Address
                        </button>
                        <button
                          type="button"
                          onClick={() => scanBarcode(input.name, input.type)} // Pass arg.name and arg.type directly
                          className={`bg-green-500 text-white py-2 px-4 rounded flex items-center justify-center ${
                            isScanning ? 'opacity-50 cursor-not-allowed' : ''
                          } flex-1`}
                          disabled={isScanning}
                          aria-label={`Scan QR Code for ${input.name}`}
                        >
                          <FaCamera className="mr-1" /> Scan
                        </button>
                      </div>
                      {inputValuesState[input.name] && (
                        <div className="mt-2 text-sm text-gray-600">
                          Selected {input.type}:{' '}
                          {shortenTxHash(
                            inputValuesState[input.name]
                            // PREFIX['testnet'].length // Adjust 'testnet' based on your network
                          )}
                        </div>
                      )}
                    </>
                  ) : (
                    <input
                      type="text"
                      name={input.name}
                      value={inputValuesState[input.name] || ''}
                      onChange={handleInputChange}
                      className="border p-2 w-full rounded-md"
                      placeholder={`Enter ${input.name}`}
                    />
                  )}
                </div>
              );
            })}
        </div>
        <div className="flex justify-end">
          <button
            className="bg-blue-500 text-white py-2 px-4 rounded mr-2"
            onClick={handleSelect}
            disabled={!selectedFunction} // Disable if no function is selected
          >
            Select
          </button>
          <button
            className="bg-gray-300 text-gray-700 py-2 px-4 rounded"
            onClick={onClose}
          >
            Cancel
          </button>
        </div>
        {showAddressPopup && selectedInput && (
          <AddressSelectionPopup
            onSelect={handleAddressSelect}
            onClose={() => {
              setShowAddressPopup(false);
              setSelectedInput(null);
            }}
          />
        )}
      </div>
    </div>
  );
};

export default SelectContractFunctionPopup;
